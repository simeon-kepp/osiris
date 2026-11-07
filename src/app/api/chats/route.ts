import { NextRequest, NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';
import { listChats } from '@/lib/chat-store';

export const dynamic = 'force-dynamic';

/** GET /api/chats: the team's conversations, newest first (metadata only). Signed out: 404, like the chat itself. */
export async function GET(_req: NextRequest) {
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });
  return NextResponse.json({ chats: await listChats() });
}
