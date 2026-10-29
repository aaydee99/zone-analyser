import { HttpError, readBody, route } from '@/lib/http';
import { installTool, removeTool, toolStatus, TOOL_NAMES, type ToolName } from '@/lib/tools';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export const GET = route(async (req) => ({
  tools: await toolStatus(new URL(req.url).searchParams.get('latest') === '1'),
}), { perm: 'runs:read' });

/** {tool, action: 'install' | 'remove'} — install also upgrades to the latest release. */
export const POST = route(async (req, _ctx, me) => {
  const { tool, action } = await readBody<{ tool: ToolName; action: 'install' | 'remove' }>(req);
  if (!TOOL_NAMES.includes(tool)) throw new HttpError(400, 'Unknown tool');
  if (action === 'remove') { removeTool(tool); await audit(me, 'tool.removed', tool); return { ok: true }; }
  const installed = await installTool(tool);
  await audit(me, 'tool.installed', tool, { version: installed.version });
  return { tool: installed };
}, { perm: 'tools:manage' });
