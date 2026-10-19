import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

const COLUMNS = 'id, title, completed, priority, due_date, created_at, updated_at';

class ValidationError extends Error {
  status = 400;
}

function parseTitle(value) {
  if (typeof value !== 'string') throw new ValidationError('title must be a string');
  const title = value.trim();
  if (title.length < 1 || title.length > 500) {
    throw new ValidationError('title must be 1-500 characters');
  }
  return title;
}

function parsePriority(value) {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    throw new ValidationError('priority must be 1, 2 or 3');
  }
  return priority;
}

function parseDueDate(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) {
    throw new ValidationError('due_date must be YYYY-MM-DD or null');
  }
  return value;
}

function parseCompleted(value) {
  if (typeof value !== 'boolean') throw new ValidationError('completed must be a boolean');
  return value;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('invalid id');
  return id;
}

async function findById(id) {
  const [rows] = await pool.query(`SELECT ${COLUMNS} FROM todos WHERE id = ?`, [id]);
  return rows[0];
}

router.get('/', async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM todos ORDER BY completed ASC, created_at DESC, id DESC`
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const body = req.body ?? {};
  const title = parseTitle(body.title);
  const priority = body.priority === undefined ? 2 : parsePriority(body.priority);
  const dueDate = body.due_date === undefined ? null : parseDueDate(body.due_date);

  const [result] = await pool.query(
    'INSERT INTO todos (title, priority, due_date) VALUES (?, ?, ?)',
    [title, priority, dueDate]
  );
  res.status(201).json(await findById(result.insertId));
});

router.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body ?? {};
  const parsers = {
    title: parseTitle,
    completed: parseCompleted,
    priority: parsePriority,
    due_date: parseDueDate,
  };

  const sets = [];
  const values = [];
  for (const [field, parse] of Object.entries(parsers)) {
    if (body[field] !== undefined) {
      values.push(parse(body[field]));
      sets.push(`${field} = ?`);
    }
  }
  if (sets.length === 0) throw new ValidationError('no updatable fields provided');

  values.push(id);
  await pool.query(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, values);
  const todo = await findById(id);
  if (!todo) return res.status(404).json({ error: 'todo not found' });
  res.json(todo);
});

router.delete('/completed', async (_req, res) => {
  const [result] = await pool.query('DELETE FROM todos WHERE completed = TRUE');
  res.json({ deleted: result.affectedRows });
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [result] = await pool.query('DELETE FROM todos WHERE id = ?', [id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'todo not found' });
  res.status(204).end();
});

export default router;
