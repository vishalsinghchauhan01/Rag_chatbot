import { listSessions, createSession } from "@/lib/db";

// GET /api/sessions — List all chat sessions
export async function GET() {
  const sessions = await listSessions();
  return Response.json(sessions);
}

// POST /api/sessions — Create a new chat session
export async function POST(req: Request) {
  const { id, university } = await req.json();
  const session = await createSession(id, university);
  return Response.json(session);
}
