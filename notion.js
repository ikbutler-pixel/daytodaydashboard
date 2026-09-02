// api/notion.js
//
// Sits between the dashboard and Notion. Holds the token server-side so it never
// reaches the browser, and works around Notion's refusal to accept browser requests.
//
// Environment variables (set these in Vercel → Settings → Environment Variables):
//   NOTION_TOKEN        your ntn_... integration secret          (required)
//   NOTION_CALENDAR_DB  Calendar database id, from its URL        (required)
//   NOTION_TASKS_DB     Tasks database id, from its URL           (required)
//   NOTION_MEALPLAN_DB  Meal Plan database id, from its URL       (optional)
//   NOTION_RECIPES_DB   Meals & Recipes database id, from its URL (optional)
//
// Database ids are the jumble in the page URL before the "?". Not secret.
// Meals & Recipes supplies the options in the meal picker; without it the picker
// falls back to whatever is already in the plan.

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2025-09-03';

// Daily repeats that should stay out of "Coming up". Type = Routine is the real
// signal; these names are a safety net for rows not yet retyped.
const ROUTINE_NAMES = ['morning routine', 'wind-down time', 'wind down time'];

const dsCache = {};

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new Error('NOTION_TOKEN is not set in Vercel. Add it under Settings → Environment Variables, then redeploy.');
  return t;
}

async function notion(path, options = {}) {
  const res = await fetch(NOTION + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const e = new Error(json.message || `Notion returned ${res.status}`);
    e.status = res.status;
    e.notion = json;
    throw e;
  }
  return json;
}

// A database id from a URL isn't the id the query endpoint wants. Look up the
// data source that sits under it, and remember it for the life of the instance.
async function dataSource(databaseId, label) {
  if (!databaseId) throw new Error(`${label} is not set in Vercel. Add it under Settings → Environment Variables, then redeploy.`);
  const clean = databaseId.replace(/-/g, '');
  if (dsCache[clean]) return dsCache[clean];
  let db;
  try {
    db = await notion(`/databases/${clean}`);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`Can't reach the database in ${label}. Either the id is wrong, or the database hasn't been shared with your integration (open it → ••• → Connections → add your integration).`);
    }
    throw e;
  }
  const list = db.data_sources || [];
  if (!list.length) throw new Error(`The database in ${label} has no data source. This is unusual — check the id.`);
  dsCache[clean] = list[0].id;
  return dsCache[clean];
}

async function queryAll(dsId, filter, sorts) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const page = await notion(`/data_sources/${dsId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    out.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

/* ---------- reading properties out of Notion's shapes ---------- */

const title = (p) => (p && p.title && p.title.map((t) => t.plain_text).join('')) || '';
const select = (p) => (p && p.select && p.select.name) || null;
const check = (p) => !!(p && p.checkbox);
const text = (p) => (p && p.rich_text && p.rich_text.map((t) => t.plain_text).join('')) || '';
const relIds = (p) => ((p && p.relation) || []).map((r) => r.id);
const dateStart = (p) => (p && p.date && p.date.start) || null;
const dateEnd = (p) => (p && p.date && p.date.end) || null;

// Raw ISO strings go to the browser untouched. The page converts them with the
// device's own clock, so a 9:30pm wind-down lands on the right evening rather
// than tomorrow morning in UTC.
function mapEvent(page) {
  const p = page.properties || {};
  const name = title(p.Name);
  const type = select(p.Type);
  const isRoutine = type === 'Routine' || ROUTINE_NAMES.includes(name.trim().toLowerCase());
  return {
    id: page.id,
    name,
    type,
    area: select(p.Area),
    location: text(p.Location),
    start: dateStart(p.Date),
    end: dateEnd(p.Date),
    routine: isRoutine,
  };
}

function mapTask(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: title(p.Name),
    date: dateStart(p.Date),          // plain YYYY-MM-DD, no time
    kind: select(p.Kind) || 'Task',
    done: check(p.Done),
  };
}

function mapMeal(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: title(p.Name),
    date: dateStart(p.Date),
    slot: select(p.Slot),
    recipe: relIds(p.Recipe),
  };
}

// The library's slot property is called "Time of Day" in Isaiah's workspace and
// "Slot" in the setup guide, so accept either.
function mapRecipe(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: title(p.Name),
    slot: select(p['Time of Day']) || select(p.Slot) || select(p.Meal) || null,
  };
}

/* ---------- reads ---------- */

async function readAll(query) {
  // Pad the window generously — the browser does the timezone conversion, so an
  // event can land a day either side of where its raw timestamp suggests.
  const from = query.from || isoDaysFromNow(-30);
  const to = query.to || isoDaysFromNow(120);

  const calDs = await dataSource(process.env.NOTION_CALENDAR_DB, 'NOTION_CALENDAR_DB');
  const taskDs = await dataSource(process.env.NOTION_TASKS_DB, 'NOTION_TASKS_DB');

  const eventsRaw = await queryAll(
    calDs,
    { and: [
      { property: 'Date', date: { on_or_after: from } },
      { property: 'Date', date: { on_or_before: to } },
    ] },
    [{ property: 'Date', direction: 'ascending' }]
  );

  // Every task, including undated ones and old rows the dashboard needs for
  // rollover and the unfinished list.
  const tasksRaw = await queryAll(taskDs, null, null);

  let mealsRaw = [];
  if (process.env.NOTION_MEALPLAN_DB) {
    const mealDs = await dataSource(process.env.NOTION_MEALPLAN_DB, 'NOTION_MEALPLAN_DB');
    mealsRaw = await queryAll(
      mealDs,
      { property: 'Date', date: { on_or_after: isoDaysFromNow(-2) } },
      [{ property: 'Date', direction: 'ascending' }]
    );
  }

  // The picker offers everything you know how to make, not just what's planned.
  let recipesRaw = [];
  if (process.env.NOTION_RECIPES_DB) {
    const recDs = await dataSource(process.env.NOTION_RECIPES_DB, 'NOTION_RECIPES_DB');
    recipesRaw = await queryAll(recDs, null, null);
  }

  return {
    events: eventsRaw.map(mapEvent).filter((e) => e.start),
    tasks: tasksRaw.map(mapTask),
    meals: mealsRaw.map(mapMeal).filter((m) => m.date && m.slot),
    recipes: recipesRaw.map(mapRecipe).filter((r) => r.name),
    mealsEnabled: !!process.env.NOTION_MEALPLAN_DB,
  };
}

function isoDaysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ---------- writes ---------- */

function dateProp(value) {
  return value ? { date: { start: value } } : { date: null };
}

async function createTask(body) {
  const ds = await dataSource(process.env.NOTION_TASKS_DB, 'NOTION_TASKS_DB');
  const name = (body.name || '').trim();
  if (!name) throw new Error('A task needs a name.');
  const page = await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: ds },
      properties: {
        Name: { title: [{ text: { content: name } }] },
        Date: dateProp(body.date || null),
        Kind: { select: { name: body.kind === 'Errand' ? 'Errand' : 'Task' } },
        Done: { checkbox: !!body.done },
      },
    }),
  });
  return { task: mapTask(page) };
}

async function updateTask(body) {
  if (!body.id) throw new Error('Missing the id of the task to update.');
  const props = {};
  if (typeof body.done === 'boolean') props.Done = { checkbox: body.done };
  if ('date' in body) props.Date = dateProp(body.date || null);
  if (typeof body.name === 'string' && body.name.trim()) {
    props.Name = { title: [{ text: { content: body.name.trim() } }] };
  }
  if (body.kind) props.Kind = { select: { name: body.kind === 'Errand' ? 'Errand' : 'Task' } };
  if (!Object.keys(props).length) throw new Error('Nothing to update.');
  const page = await notion(`/pages/${body.id.replace(/-/g, '')}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
  return { task: mapTask(page) };
}

async function deleteTask(body) {
  if (!body.id) throw new Error('Missing the id of the task to remove.');
  // Archiving, not destroying — it goes to Notion's trash and can be restored.
  const page = await notion(`/pages/${body.id.replace(/-/g, '')}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
  return { id: page.id };
}

// Change what's planned for one slot on one day. Updates the row if it exists,
// creates it if the slot was empty. The chosen meal is linked back to its entry
// in the recipe library so calories and protein still roll up.
async function setMeal(body) {
  if (!process.env.NOTION_MEALPLAN_DB) throw new Error('NOTION_MEALPLAN_DB is not set, so meals can\'t be changed.');
  const ds = await dataSource(process.env.NOTION_MEALPLAN_DB, 'NOTION_MEALPLAN_DB');
  const name = (body.name || '').trim();
  if (!name) throw new Error('Pick a meal.');
  if (!body.slot) throw new Error('Missing the slot.');

  const props = {
    Name: { title: [{ text: { content: name } }] },
  };
  if (body.recipeId) {
    props.Recipe = { relation: [{ id: body.recipeId.replace(/-/g, '') }] };
  } else if (Array.isArray(body.recipe)) {
    props.Recipe = { relation: body.recipe.map((id) => ({ id })) };
  }

  if (body.id) {
    const page = await notion(`/pages/${body.id.replace(/-/g, '')}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: props }),
    });
    return { meal: mapMeal(page) };
  }

  if (!body.date) throw new Error('Missing the date.');
  props.Date = dateProp(body.date);
  props.Slot = { select: { name: body.slot } };
  const page = await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: ds },
      properties: props,
    }),
  });
  return { meal: mapMeal(page) };
}

/* ---------- entry point ---------- */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const data = await readAll(req.query || {});
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      switch (body.action) {
        case 'createTask': return res.status(200).json(await createTask(body));
        case 'updateTask': return res.status(200).json(await updateTask(body));
        case 'deleteTask': return res.status(200).json(await deleteTask(body));
        case 'setMeal':    return res.status(200).json(await setMeal(body));
        default:
          return res.status(400).json({ error: 'Unknown action: ' + body.action });
      }
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({
      error: 'notion',
      message: err.message || 'Something went wrong talking to Notion.',
    });
  }
}
