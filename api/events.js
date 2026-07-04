// Serverless function: securely reads your Notion Calendar and returns clean event JSON.
// Your secret token lives here on the server (as an environment variable) — never in the browser.

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID;

  if (!token || !dataSourceId) {
    return res.status(500).json({
      error: 'setup',
      message:
        'Missing NOTION_TOKEN or NOTION_DATA_SOURCE_ID. Add both in your Vercel project settings under Environment Variables, then redeploy.',
    });
  }

  try {
    const events = [];
    let cursor;

    // Notion returns pages in batches of 100 — loop until we have them all.
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;

      const r = await fetch(
        `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': '2025-09-03',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      if (!r.ok) {
        const detail = await r.text();
        return res.status(r.status).json({
          error: 'notion',
          message:
            r.status === 404
              ? 'Notion could not find the database, or your integration has not been shared with it. Open the Calendar database in Notion → ••• menu → Connections → add your integration.'
              : 'Notion API error. Double-check your token and data source ID.',
          detail,
        });
      }

      const data = await r.json();
      data.results.forEach((page) => events.push(normalize(page)));
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    // Cache at the edge for 60s so quick refreshes don't re-hit Notion.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ events });
  } catch (e) {
    return res.status(500).json({ error: 'server', message: String(e) });
  }
}

function plain(rich) {
  return rich && rich.length ? rich.map((t) => t.plain_text).join('') : '';
}

function normalize(page) {
  const p = page.properties || {};

  const name = p.Name && p.Name.title ? plain(p.Name.title) : '(Untitled)';
  const type = p.Type && p.Type.select ? p.Type.select.name : null;
  const area = p.Area && p.Area.select ? p.Area.select.name : null;
  const location = p.Location && p.Location.rich_text ? plain(p.Location.rich_text) : '';
  const done = p.Done && typeof p.Done.checkbox === 'boolean' ? p.Done.checkbox : false;

  let start = null,
    end = null,
    hasTime = false;
  if (p.Date && p.Date.date) {
    start = p.Date.date.start;
    end = p.Date.date.end;
    hasTime = !!(start && start.includes('T'));
  }

  return { id: page.id, name, type, area, location, done, start, end, hasTime };
}
