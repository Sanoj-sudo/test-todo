# Orbit — 3D Todo App

A todo app with a glassmorphism UI on top of a live **Three.js** scene. Every task is a glowing orb orbiting a 3D core:

- **Outer ring** = active tasks, colored by priority (blue = low, amber = medium, pink = high)
- **Inner ring** = completed tasks (green). Completing a task triggers a particle burst.
- The core shifts from violet to green as your completion % rises.
- Hover an orb to see its task; click it to jump to that task in the list. Hover a task to highlight its orb.

Features: add / complete / edit (double‑click) / delete, priorities, due dates (overdue/today labels), filters, clear completed, progress ring, keyboard shortcut `/`, responsive layout, `prefers-reduced-motion` support.

**Stack:** Node.js 20+ · Express 5 · MySQL (AWS RDS) · Three.js (served from `node_modules`, no build step).

```
server/
  index.js          Express app, security headers, static files, graceful shutdown
  db.js             mysql2 pool (RDS TLS support) + auto-migration
  routes/todos.js   REST API
public/
  index.html, styles.css
  app.js            UI logic
  scene.js          Three.js scene
deploy/
  setup-ec2.sh      One-shot EC2 provisioning / redeploy script
  todoapp.service   systemd unit
  nginx.conf        Reverse proxy :80 -> :3000
```

## API

| Method | Path                   | Body                                          |
| ------ | ---------------------- | --------------------------------------------- |
| GET    | `/api/health`          | — (checks DB connectivity)                    |
| GET    | `/api/todos`           | —                                             |
| POST   | `/api/todos`           | `{ title, priority?: 1-3, due_date?: "YYYY-MM-DD" }` |
| PATCH  | `/api/todos/:id`       | any of `{ title, completed, priority, due_date }` |
| DELETE | `/api/todos/:id`       | —                                             |
| DELETE | `/api/todos/completed` | —                                             |

The database (`DB_NAME`) and the `todos` table are created automatically on startup.

## Run locally

```bash
npm install
docker compose up -d        # local MySQL on :3306 (user/pass: root/root)
npm run dev                 # http://localhost:3000
```

No `.env` is needed locally, since the defaults match docker-compose. If port 3306 is already taken (e.g. by XAMPP), either stop that MySQL or point `.env` at it. To point at another database, copy `.env.example` to `.env`.

---

## Deploy to AWS (EC2 + RDS)

### 1. Create the RDS MySQL database

RDS console → **Create database**:

- **Engine:** MySQL 8.0 or 8.4
- **Template:** Free tier (or Production)
- **DB instance identifier:** `todoapp-db`
- **Master username / password:** pick them and save them for `.env`
- **Instance class:** `db.t4g.micro` is fine to start
- **Connectivity:** same VPC as your EC2 instance, **Public access: No**
- **Initial database name:** optional. The app creates `todoapp` itself on first start.

After it's created, copy the **Endpoint** (e.g. `todoapp-db.abc123.us-east-1.rds.amazonaws.com`).

### 2. Launch the EC2 instance

- **AMI:** Amazon Linux 2023 or Ubuntu 24.04
- **Type:** `t3.micro` / `t3.small`
- **Security group (inbound):** SSH 22 from *your IP*, HTTP 80 and HTTPS 443 from anywhere

### 3. Let EC2 talk to RDS

Pick one:
- **Easiest:** RDS console → your DB → **Actions → Set up EC2 connection** → choose your instance. AWS creates the security group rules for you.
- **Manual:** edit the RDS security group and add an inbound rule: **MYSQL/Aurora 3306**, source = **the EC2 instance's security group**.

### 4. Copy the code to the instance

```bash
# from your machine (or push to GitHub and `git clone` on the instance)
COPYFILE_DISABLE=1 tar --exclude node_modules --exclude .env -czf - . | \
  ssh -i your-key.pem ec2-user@<EC2_PUBLIC_IP> 'mkdir -p ~/todoapp && tar -xzf - -C ~/todoapp'
# use ubuntu@ instead of ec2-user@ on Ubuntu
```

### 5. Provision and start

```bash
ssh -i your-key.pem ec2-user@<EC2_PUBLIC_IP>
cd ~/todoapp
sudo bash deploy/setup-ec2.sh          # first run installs Node/nginx and creates /opt/todoapp/.env
sudo nano /opt/todoapp/.env            # set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
sudo bash deploy/setup-ec2.sh          # second run starts the app + nginx
```

Open `http://<EC2_PUBLIC_IP>/` 🎉

The script:
- installs Node 22 and nginx
- creates a locked-down `todoapp` system user
- copies the app to `/opt/todoapp` and runs `npm ci --omit=dev`
- downloads the RDS CA bundle so the connection is TLS-verified
- installs the systemd service and the nginx reverse proxy

### Redeploying

Copy the new code to `~/todoapp` again and re-run `sudo bash deploy/setup-ec2.sh`. Your `.env` stays as it is.

### Operations

```bash
sudo systemctl status todoapp
sudo journalctl -u todoapp -f          # live logs
curl localhost:3000/api/health
```

### HTTPS (recommended)

Point a domain's A record at the instance (use an **Elastic IP** so the address doesn't change), set `server_name` in `/etc/nginx/conf.d/todoapp.conf`, then:

```bash
# Amazon Linux 2023
sudo dnf install -y certbot python3-certbot-nginx
# Ubuntu
sudo apt-get install -y certbot python3-certbot-nginx

sudo certbot --nginx -d todo.example.com
```

Then set `ENABLE_HSTS=true` in `.env` and run `sudo systemctl restart todoapp`.

### Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `failed to connect / migrate: timeout` | RDS security group doesn't allow 3306 from the EC2 security group, or they're in different VPCs. |
| `Connections using insecure transport are prohibited` | Set `DB_SSL=true`. |
| `Access denied for user ... to database` | The DB user can't create databases. Create it manually (`CREATE DATABASE todoapp;`) or use the master user. |
| `There was an error establishing an SSL connection` | That's a PostgreSQL-driver message, so you're running an old copy of the code. Copy the latest code over and re-run the setup script. |
| `Access denied for user` | Check `DB_USER` / `DB_PASSWORD` in `/opt/todoapp/.env`. |
| nginx 502 | App isn't running: `sudo journalctl -u todoapp -n 50`. |
| Page loads but the 3D scene is blank | The browser or GPU has no WebGL. The todo list still works. |

**Security notes:** keep RDS private (no public access), never commit `.env`, and for production consider storing the DB password in AWS Secrets Manager or SSM Parameter Store.
