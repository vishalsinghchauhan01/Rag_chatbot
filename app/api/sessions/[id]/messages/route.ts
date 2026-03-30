import { saveMessage } from "@/lib/db";

// POST /api/sessions/[id]/messages — Save a message to a session
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { role, content } = await req.json();
  const message = await saveMessage(id, role, content);
  return Response.json(message);
}
