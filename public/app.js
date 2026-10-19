import { createScene } from '/scene.js';

// ---------- API ----------
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const api = {
  list: () => request('GET', '/api/todos'),
  create: (todo) => request('POST', '/api/todos', todo),
  update: (id, patch) => request('PATCH', `/api/todos/${id}`, patch),
  remove: (id) => request('DELETE', `/api/todos/${id}`),
  clearCompleted: () => request('DELETE', '/api/todos/completed'),
};

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const emptyEl = $('#empty');
const emptyText = $('#empty-text');
const composer = $('#composer');
const titleInput = $('#title');
const filtersEl = $('.filters');
const remainingEl = $('#remaining');
const clearBtn = $('#clear-completed');
const progressBar = $('#progress-bar');
const progressText = $('#progress-text');
const tooltip = $('#tooltip');
const toastEl = $('#toast');

const PRIORITY_LABEL = { 1: 'Low', 2: 'Medium', 3: 'High' };
const CIRCUMFERENCE = 2 * Math.PI * 18;

let todos = [];
let filter = 'all';
let loaded = false;
const rows = new Map(); // id -> <li>

// ---------- Helpers ----------
function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function describeDue(due) {
  if (!due) return null;
  const today = localDateString();
  const tomorrow = localDateString(new Date(Date.now() + 86_400_000));
  const pretty = new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (due < today) return { text: `Overdue · ${pretty}`, cls: 'overdue' };
  if (due === today) return { text: 'Due today', cls: 'today' };
  if (due === tomorrow) return { text: 'Tomorrow', cls: '' };
  return { text: pretty, cls: '' };
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

function sorted(list) {
  return [...list].sort(
    (a, b) => a.completed - b.completed || new Date(b.created_at) - new Date(a.created_at)
  );
}

function visible(todo) {
  if (filter === 'active') return !todo.completed;
  if (filter === 'done') return todo.completed;
  return true;
}

function svg(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstChild;
}

// ---------- Rendering ----------
function createRow(todo) {
  const li = document.createElement('li');
  li.className = 'todo entering';
  li.dataset.id = todo.id;
  li.addEventListener('animationend', () => li.classList.remove('entering', 'flash'));

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.append(svg('<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>'));
  check.addEventListener('click', () => toggle(Number(li.dataset.id)));

  const body = document.createElement('div');
  body.className = 'todo-body';
  const title = document.createElement('span');
  title.className = 'todo-title';
  title.title = 'Double-click to edit';
  title.addEventListener('dblclick', () => startEdit(li));
  const meta = document.createElement('div');
  meta.className = 'todo-meta';
  body.append(title, meta);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn';
  del.setAttribute('aria-label', 'Delete task');
  del.append(svg('<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>'));
  del.addEventListener('click', () => remove(Number(li.dataset.id)));

  li.addEventListener('mouseenter', () => scene.highlight(todo.id));
  li.addEventListener('mouseleave', () => scene.highlight(null));

  li.append(check, body, del);
  return li;
}

function updateRow(li, todo) {
  li.dataset.priority = todo.priority;
  li.classList.toggle('done', todo.completed);
  const check = li.querySelector('.check');
  check.setAttribute('aria-label', todo.completed ? 'Mark as not done' : 'Mark as done');
  check.setAttribute('aria-pressed', String(todo.completed));

  const title = li.querySelector('.todo-title');
  if (title && title.textContent !== todo.title) title.textContent = todo.title;

  const meta = li.querySelector('.todo-meta');
  meta.replaceChildren();
  const prio = document.createElement('span');
  prio.className = 'priority';
  prio.textContent = PRIORITY_LABEL[todo.priority];
  meta.append(prio);
  const due = describeDue(todo.due_date);
  if (due) {
    const span = document.createElement('span');
    span.className = `due ${due.cls}`;
    span.textContent = due.text;
    meta.append(span);
  }
}

function render() {
  const ordered = sorted(todos).filter(visible);
  const keep = new Set(ordered.map((t) => t.id));

  for (const [id, li] of rows) {
    if (!keep.has(id) && !li.classList.contains('leaving')) {
      li.classList.add('leaving');
      setTimeout(() => {
        li.remove();
        if (rows.get(id) === li) rows.delete(id);
      }, 300);
    }
  }

  ordered.forEach((todo, index) => {
    let li = rows.get(todo.id);
    if (!li || li.classList.contains('leaving')) {
      li?.remove();
      li = createRow(todo);
      rows.set(todo.id, li);
    }
    updateRow(li, todo);
    const current = listEl.children[index];
    if (current !== li) listEl.insertBefore(li, current ?? null);
  });

  // Counts, progress, empty state
  const done = todos.filter((t) => t.completed).length;
  const active = todos.length - done;
  filtersEl.querySelector('[data-count="all"]').textContent = todos.length;
  filtersEl.querySelector('[data-count="active"]').textContent = active;
  filtersEl.querySelector('[data-count="done"]').textContent = done;

  const ratio = todos.length ? done / todos.length : 0;
  progressBar.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - ratio));
  progressText.textContent = `${Math.round(ratio * 100)}%`;

  remainingEl.textContent = loaded
    ? active === 0
      ? todos.length ? 'All done — nice work ✨' : 'Nothing here yet'
      : `${active} task${active === 1 ? '' : 's'} left`
    : '—';
  clearBtn.disabled = done === 0;

  if (loaded) {
    emptyText.textContent =
      filter === 'done' ? 'No completed tasks yet.' :
      filter === 'active' && todos.length ? 'Everything is done. Enjoy the view.' :
      'Your universe is empty. Add your first task.';
  }
  emptyEl.classList.toggle('visible', ordered.length === 0);

  scene.sync(todos);
}

// ---------- Actions ----------
async function add(event) {
  event.preventDefault();
  const form = new FormData(composer);
  const title = String(form.get('title') || '').trim();
  if (!title) return;

  const submit = composer.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const todo = await api.create({
      title,
      priority: Number(form.get('priority')),
      due_date: form.get('due_date') || null,
    });
    todos.push(todo);
    if (filter === 'done') setFilter('all');
    render();
    scene.pulse();
    titleInput.value = '';
    composer.querySelector('.date-input').value = '';
  } catch (err) {
    toast(err.message);
  } finally {
    submit.disabled = false;
    titleInput.focus();
  }
}

async function patch(id, changes) {
  const index = todos.findIndex((t) => t.id === id);
  if (index === -1) return;
  const previous = todos[index];
  todos[index] = { ...previous, ...changes };
  render();
  try {
    const saved = await api.update(id, changes);
    const i = todos.findIndex((t) => t.id === id);
    if (i !== -1) todos[i] = saved;
    render();
    return true;
  } catch (err) {
    const i = todos.findIndex((t) => t.id === id);
    if (i !== -1) todos[i] = previous;
    render();
    toast(err.message);
    return false;
  }
}

async function toggle(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  const completing = !todo.completed;
  if (completing) scene.celebrate(id);
  await patch(id, { completed: completing });
}

async function remove(id) {
  const previous = todos;
  todos = todos.filter((t) => t.id !== id);
  render();
  try {
    await api.remove(id);
  } catch (err) {
    todos = previous;
    render();
    toast(err.message);
  }
}

async function clearCompleted() {
  const previous = todos;
  todos = todos.filter((t) => !t.completed);
  render();
  try {
    await api.clearCompleted();
  } catch (err) {
    todos = previous;
    render();
    toast(err.message);
  }
}

function startEdit(li) {
  const id = Number(li.dataset.id);
  const todo = todos.find((t) => t.id === id);
  const title = li.querySelector('.todo-title');
  if (!todo || !title) return;

  const input = document.createElement('input');
  input.className = 'todo-edit';
  input.value = todo.title;
  input.maxLength = 500;
  input.setAttribute('aria-label', 'Edit task');
  title.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    title.textContent = todo.title;
    input.replaceWith(title);
    if (save && value && value !== todo.title) patch(id, { title: value });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function setFilter(next) {
  filter = next;
  filtersEl.dataset.active = next;
  filtersEl.querySelectorAll('button').forEach((b) => {
    const active = b.dataset.filter === next;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  render();
}

function selectFromScene(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  if (!visible(todo)) setFilter('all');
  const li = rows.get(id);
  if (!li) return;
  li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  li.classList.remove('flash');
  void li.offsetWidth; // restart animation
  li.classList.add('flash');
}

function showTooltip(todo, x, y) {
  if (!todo) {
    tooltip.hidden = true;
    return;
  }
  tooltip.replaceChildren();
  tooltip.append(todo.title);
  const small = document.createElement('small');
  const due = describeDue(todo.due_date);
  small.textContent = [todo.completed ? 'Completed' : `${PRIORITY_LABEL[todo.priority]} priority`, due?.text]
    .filter(Boolean)
    .join(' · ');
  tooltip.append(small);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.hidden = false;
}

// ---------- Boot ----------
const scene = createScene(document.getElementById('scene'), {
  onSelect: selectFromScene,
  onHover: showTooltip,
});

function setGreeting() {
  const h = new Date().getHours();
  $('#greeting').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

composer.addEventListener('submit', add);
clearBtn.addEventListener('click', clearCompleted);
filtersEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (btn) setFilter(btn.dataset.filter);
});
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, [contenteditable]');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    titleInput.focus();
  }
});

setGreeting();
setFilter('all');

api
  .list()
  .then((data) => {
    todos = data;
    loaded = true;
    render();
  })
  .catch((err) => {
    emptyText.textContent = 'Could not reach the server.';
    toast(err.message);
  });
