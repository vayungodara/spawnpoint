// `spawnpoint mcp`: the CLI's commands as MCP tools over stdio
// (newline-delimited JSON-RPC 2.0). One tool per command group keeps the
// tool list small, and lets a client gate `change` or `files` separately
// from read-only tools like `status`. Each tool takes the same arguments
// as the CLI, so one guide covers both.
import { createInterface } from 'node:readline';

const READ_ONLY = new Set(['status']);

function tools({ commands, GROUPS }) {
  const byGroup = {};
  for (const c of Object.values(commands)) {
    if (c.group === 'admin') continue;
    (byGroup[c.group] ??= []).push(c);
  }
  return Object.entries(byGroup).map(([group, cmds]) => ({
    name: group,
    description: `${GROUPS[group]}. Pass CLI arguments after "spawnpoint", e.g. "${cmds[0].usage.split(' [')[0]}".\n${cmds.map((c) => `${c.usage} — ${c.about}`).join('\n')}`,
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'string', description: 'arguments as on the command line, starting with the command; add --json for exact data' },
      },
      required: group === 'status' ? [] : ['args'],
    },
    annotations: { readOnlyHint: READ_ONLY.has(group), openWorldHint: false },
  }));
}

/** The CLI passes itself in: importing it back would wait on its own
    top-level await. */
export async function serve(cli) {
  const { commands, VERSION, helpText, run, words } = cli;
  const list = tools(cli);
  const names = new Set(list.map((t) => t.name));
  const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    if (!msg || typeof msg !== 'object') { send({ id: null, error: { code: -32600, message: 'invalid request' } }); continue; }
    const { id, method, params } = msg;
    if (id === undefined) continue; // notifications need no answer
    if (method === 'initialize') {
      send({ id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'spawnpoint', version: VERSION },
        instructions: helpText(true, true),
      } });
    } else if (method === 'ping') send({ id, result: {} });
    else if (method === 'tools/list') send({ id, result: { tools: list } });
    else if (method === 'tools/call') {
      const name = params?.name;
      if (!names.has(name)) { send({ id, error: { code: -32602, message: `unknown tool ${name}` } }); continue; }
      let argv;
      try { argv = words(params?.arguments?.args ?? ''); } catch (e) { send({ id, result: { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] } }); continue; }
      // the status tool runs `status` by default; other tools start with their command word
      if (name === 'status' && !argv.length) argv = ['status'];
      const known = Object.values(commands).find((c) => c.group === name && (c.name === argv[0] || c.name.split(' ')[0] === argv[0]));
      if (!known) argv = [Object.values(commands).find((c) => c.group === name).name.split(' ')[0], ...argv];
      // calls run concurrently, so a long --wait never blocks ping
      void run(argv, { mcp: true, tty: false, stdin: false, keepAlive: true, baseUrl: cli.baseUrl }).then((r) => {
        const text = [r.stdout, r.stderr].filter(Boolean).join('\n') || 'ok';
        send({ id, result: { isError: r.code !== 0, content: [{ type: 'text', text: r.code ? `${text}\n(exit ${r.code})` : text }] } });
      });
    } else send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
