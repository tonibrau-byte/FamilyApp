// FamilyApp — Vercel Serverless Function
// POST /api/chat
// Proxies Claude API, executes tool calls against Supabase.
// The Anthropic API key never reaches the client.

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_LOOPS = 10;

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'create_item',
    description:
      'Add a new item (flight, hotel, restaurant, activity, ticket, or note) to the trip. ' +
      'Call this when the user says add, book, reserve, or pastes a recommendation from a friend.',
    input_schema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        type:        { type: 'string', enum: ['flight','hotel','restaurant','activity','ticket','note'] },
        title:       { type: 'string', description: 'Short label, e.g. "Lufthansa LH714 Munich→Tokyo"' },
        date:        { type: 'string', description: 'YYYY-MM-DD, the day this item starts' },
        start_time:  { type: 'string', description: 'HH:MM in 24h format' },
        end_time:    { type: 'string', description: 'HH:MM in 24h format' },
        location:    { type: 'string', description: 'City, address, or venue name' },
        notes:       { type: 'string', description: 'Details, confirmation numbers, recommendation text' },
        url:         { type: 'string', description: 'Booking link or reference URL' },
        airline:     { type: 'string' },
        flight_num:  { type: 'string' },
        origin:      { type: 'string', description: 'IATA code or city' },
        destination: { type: 'string', description: 'IATA code or city' },
        check_in:    { type: 'string', description: 'Hotel check-in YYYY-MM-DD' },
        check_out:   { type: 'string', description: 'Hotel check-out YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'update_item',
    description:
      'Modify an existing trip item. Use when the user says change, update, correct, move, or reschedule.',
    input_schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id:          { type: 'string', description: 'UUID of the item to update' },
        title:       { type: 'string' },
        date:        { type: 'string' },
        start_time:  { type: 'string' },
        end_time:    { type: 'string' },
        location:    { type: 'string' },
        notes:       { type: 'string' },
        url:         { type: 'string' },
        airline:     { type: 'string' },
        flight_num:  { type: 'string' },
        origin:      { type: 'string' },
        destination: { type: 'string' },
        check_in:    { type: 'string' },
        check_out:   { type: 'string' },
      },
    },
  },
  {
    name: 'delete_item',
    description: 'Remove a trip item. Use when the user says delete, remove, cancel, or we are not doing.',
    input_schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'UUID of the item to delete' },
      },
    },
  },
  {
    name: 'set_trip_dates',
    description: 'Update the trip name, start date, or end date.',
    input_schema: {
      type: 'object',
      properties: {
        name:       { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'query_items',
    description:
      'Look up items to answer questions like "what hotel on June 18", "list all restaurants", ' +
      '"what time is our flight". Does not modify data.',
    input_schema: {
      type: 'object',
      properties: {
        type:        { type: 'string', enum: ['flight','hotel','restaurant','activity','ticket','note'] },
        date:        { type: 'string', description: 'Exact date YYYY-MM-DD' },
        date_from:   { type: 'string', description: 'Start of date range YYYY-MM-DD' },
        date_to:     { type: 'string', description: 'End of date range YYYY-MM-DD' },
        search_text: { type: 'string', description: 'Substring match on title, location, notes' },
      },
    },
  },
];

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function supabase(path, method = 'GET', body = null, token = null) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${token ?? SUPABASE_SERVICE_KEY}`,
    'Prefer': method === 'POST' ? 'return=representation' : '',
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getUserFromToken(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

// ─── Tool executors ───────────────────────────────────────────────────────────

async function execCreateItem(input, tripId, userId) {
  const row = { ...input, trip_id: tripId, added_by: userId };
  const result = await supabase('trip_items', 'POST', row);
  const item = Array.isArray(result) ? result[0] : result;
  return { success: true, id: item?.id, item };
}

async function execUpdateItem(input, tripId) {
  const { id, ...fields } = input;
  // Safety: only update if the item belongs to this trip
  const encoded = encodeURIComponent(`${id}`);
  await supabase(
    `trip_items?id=eq.${encoded}&trip_id=eq.${tripId}`,
    'PATCH',
    fields
  );
  return { success: true };
}

async function execDeleteItem(input, tripId) {
  const encoded = encodeURIComponent(input.id);
  await supabase(
    `trip_items?id=eq.${encoded}&trip_id=eq.${tripId}`,
    'DELETE'
  );
  return { success: true };
}

async function execSetTripDates(input, tripId, userId) {
  await supabase(
    `trips?id=eq.${tripId}&created_by=eq.${userId}`,
    'PATCH',
    input
  );
  return { success: true };
}

async function execQueryItems(input, tripId) {
  let path = `trip_items?trip_id=eq.${tripId}&order=date.asc,start_time.asc`;
  if (input.type)        path += `&type=eq.${input.type}`;
  if (input.date)        path += `&date=eq.${input.date}`;
  if (input.date_from)   path += `&date=gte.${input.date_from}`;
  if (input.date_to)     path += `&date=lte.${input.date_to}`;
  if (input.search_text) {
    const q = encodeURIComponent(input.search_text);
    path += `&or=(title.ilike.*${q}*,location.ilike.*${q}*,notes.ilike.*${q}*)`;
  }
  const items = await supabase(path);
  return { items: items || [] };
}

async function executeTool(toolName, input, tripId, userId) {
  switch (toolName) {
    case 'create_item':    return execCreateItem(input, tripId, userId);
    case 'update_item':    return execUpdateItem(input, tripId);
    case 'delete_item':    return execDeleteItem(input, tripId);
    case 'set_trip_dates': return execSetTripDates(input, tripId, userId);
    case 'query_items':    return execQueryItems(input, tripId);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, trip_id: tripId, supabase_token: token } = req.body ?? {};

  if (!messages || !tripId || !token) {
    return res.status(400).json({ error: 'Missing messages, trip_id, or supabase_token' });
  }

  // 1. Verify the caller is authenticated
  const user = await getUserFromToken(token);
  if (!user?.id) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  // 2. Verify membership
  const members = await supabase(
    `trip_members?trip_id=eq.${tripId}&user_id=eq.${user.id}&select=role`
  );
  if (!members?.length) {
    return res.status(403).json({ error: 'Not a member of this trip' });
  }

  // 3. Load trip context
  const [tripRows, itemRows] = await Promise.all([
    supabase(`trips?id=eq.${tripId}&select=name,start_date,end_date`),
    supabase(
      `trip_items?trip_id=eq.${tripId}&order=date.asc,start_time.asc` +
      `&select=id,type,title,date,start_time,location,notes,airline,flight_num,origin,destination,check_in,check_out`
    ),
  ]);

  const trip = tripRows?.[0] ?? {};
  const items = itemRows ?? [];

  const itemsSummary = items.map(it => {
    const parts = [`[${it.id}]`, it.type.toUpperCase(), it.title];
    if (it.date) parts.push(it.date);
    if (it.start_time) parts.push(it.start_time);
    if (it.location) parts.push(`@ ${it.location}`);
    if (it.origin && it.destination) parts.push(`${it.origin}→${it.destination}`);
    if (it.flight_num) parts.push(it.flight_num);
    return parts.join(' | ');
  }).join('\n') || '(no items yet)';

  const today = new Date().toISOString().split('T')[0];
  const tripDates = trip.start_date && trip.end_date
    ? `${trip.start_date} to ${trip.end_date}`
    : 'dates not set yet';

  const systemPrompt =
    `You are a friendly family travel assistant for the trip "${trip.name || 'Unnamed Trip'}" (${tripDates}).\n` +
    `Today is ${today}.\n\n` +
    `Current trip items:\n${itemsSummary}\n\n` +
    `Guidelines:\n` +
    `- When the user adds something, call create_item. Confirm briefly what you saved.\n` +
    `- When the user pastes WhatsApp recommendations, ignore sender names and timestamps. ` +
    `  Extract each recommendation and call create_item with type "note" for each one.\n` +
    `- When the user asks a question about the itinerary, call query_items if needed, then answer conversationally.\n` +
    `- Always use YYYY-MM-DD for dates, HH:MM for times in tool calls.\n` +
    `- Infer the year from the trip dates when the user omits it.\n` +
    `- For hotels: always set check_in and check_out, AND also set date = check_in.\n` +
    `- For flights: set date to the departure date.\n` +
    `- Respond in the same language the user writes in.`;

  // 4. Agentic loop
  const mutations = [];
  let conversation = [...messages];
  let loops = 0;

  while (loops < MAX_TOOL_LOOPS) {
    loops++;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages: conversation,
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(502).json({ error: `Claude API error: ${err}` });
    }

    const claudeData = await claudeRes.json();

    // Append Claude's response to conversation
    conversation.push({ role: 'assistant', content: claudeData.content });

    if (claudeData.stop_reason !== 'tool_use') {
      // Done — extract the final text reply
      const textBlock = claudeData.content.find(b => b.type === 'text');
      return res.status(200).json({
        reply: textBlock?.text ?? '',
        mutations,
      });
    }

    // Execute all tool calls in parallel
    const toolUseBlocks = claudeData.content.filter(b => b.type === 'tool_use');
    const toolResults = await Promise.all(
      toolUseBlocks.map(async block => {
        const result = await executeTool(block.name, block.input, tripId, user.id);

        // Track mutations for the client to update UI immediately
        if (block.name === 'create_item' && result.item) {
          mutations.push({ action: 'created', item: result.item });
        } else if (block.name === 'update_item') {
          mutations.push({ action: 'updated', id: block.input.id });
        } else if (block.name === 'delete_item') {
          mutations.push({ action: 'deleted', id: block.input.id });
        } else if (block.name === 'set_trip_dates') {
          mutations.push({ action: 'trip_updated', fields: block.input });
        }

        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      })
    );

    conversation.push({ role: 'user', content: toolResults });
  }

  return res.status(200).json({
    reply: 'He procesado tu solicitud.',
    mutations,
  });
}
