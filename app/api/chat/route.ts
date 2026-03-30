import { openai } from "@ai-sdk/openai";
import { streamText, convertToModelMessages } from "ai";
import { smartSearch, getAllPrograms } from "@/lib/db";

// Generate embedding for the user's question using OpenAI API
async function embedQuestion(text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  const data = await response.json();
  return data.data[0].embedding;
}

// Detect question category for prioritized search
// Returns a single category or array of categories for cross-category queries
function detectQueryCategory(question: string): string | string[] | undefined {
  const q = question.toLowerCase();

  // Personal eligibility / "what course can I take" / percentage-based questions
  // These need BOTH courses (for program details) and admissions (for eligibility criteria)
  if (q.match(/what.*(course|branch|program|stream).*(?:take|join|choose|do|get|select)|(?:which|suggest|recommend).*(course|branch|program)|i\s+(?:got|have|scored|completed|passed).*%|pcm|pcb|commerce|arts|science.*stream|12th|12|10\+2|intermediate|hsc|eligible/))
    return ["courses", "admissions"];

  if (q.match(/place|package|salary|recruit|lpa|ctc|hire|offer|company|compan/))
    return "placements";
  // Fee data exists in both admissions pages and individual course pages
  if (q.match(/fee|cost|scholarship|tuition|expense|payment|refund|loan/))
    return ["admissions", "courses"];
  if (q.match(/admiss|eligib|apply|entrance|cutoff|jee|cuet|counseli/))
    return "admissions";
  if (q.match(/course|program|syllab|branch|b\.?tech|m\.?tech|mba|mca|bca|b\.?arch|phd|doctoral|bsc|msc|b\.?pharm/))
    return "courses";
  if (q.match(/facult|professor|teacher|hod|dean|staff/))
    return "faculty";
  if (q.match(/hostel|campus|facilit|library|lab|sport|canteen|mess|gym|transport/))
    return "campus";
  if (q.match(/research|patent|publication|journal|paper/))
    return "research";
  if (q.match(/about|history|rank|naac|nirf|accredit|vision|mission|founder/))
    return "about";

  return undefined;
}

export async function POST(req: Request) {
  const body = await req.json();
  const messages = body.messages;
  const university = body.university || "dit-university";

  // Guard: if no messages, return an error
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "No messages provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Extract the question text from the latest user message
  const lastMessage = messages[messages.length - 1];
  const question =
    lastMessage.content ||
    (lastMessage.parts
      ?.filter((p: { type: string }) => p.type === "text")
      .map((p: { text: string }) => p.text)
      .join(" ") ?? "");

  // Detect category for prioritized search
  const category = detectQueryCategory(question);

  // Detect if user is asking for a comprehensive list of all courses/programs
  const isAllCoursesQuery = /all.*course|all.*program|list.*course|list.*program|how many.*course|how many.*program|courses.*available|programs.*available|courses.*offer|programs.*offer|kitne.*course|kaun.*kaun.*course|saare.*course|sab.*course|kya.*kya.*course/i.test(question);

  // Embed the question
  const questionEmbedding = await embedQuestion(question);

  // Smart search: category-specific + global, deduplicated, top 10
  const relevantChunks = await smartSearch(questionEmbedding, university, category);

  // Build rich context with source attribution
  const context = relevantChunks
    .map(
      (chunk: { content: string; source: string; category: string; similarity: number }, i: number) =>
        `[Source ${i + 1}] (${chunk.category}) ${chunk.source}\n${chunk.content}`
    )
    .join("\n\n---\n\n");

  // If asking for all courses, fetch the complete program list from DB
  let programListContext = "";
  if (isAllCoursesQuery) {
    const programs = await getAllPrograms(university);
    if (programs.length > 0) {
      programListContext = `\n\n## COMPLETE LIST OF ALL PROGRAMS OFFERED (${programs.length} programs)\n${programs.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
    }
  }

  // Build the system prompt
  const hasContext = relevantChunks.length > 0 || programListContext.length > 0;

  const systemPrompt = `You are a friendly and helpful university counselor assistant for Uttarakhand universities. You answer questions using ONLY the data provided below. You are NOT a general knowledge assistant.

## CORE RULES

1. **All facts, numbers, names, and statistics MUST come from the context below.** Do NOT invent any data. Do NOT use your training data for university-specific information.
2. **You CAN reason, recommend, and advise** based on the context data. If a student says "I scored 60% in PCM, what course can I take?", look at the eligibility criteria in the context and recommend matching courses. This is reasoning, not hallucination.
3. **NEVER answer about universities/institutions NOT in the context.** If someone asks about IIT Roorkee, Harvard, or any institution not in the context, say: "I don't have data for that institution in my database."
4. **When showing fee data**, present ONLY the exact numbers from the context. Do NOT mix "ALL INDIA CATEGORY" with "UTTARAKHAND/HIMALAYAN STATE CATEGORY" — they are completely different fee structures.
5. **Do NOT reformat, round, or recalculate any numbers.** Show them exactly as they appear.
6. **If the context has NO relevant information for the question**, say: "I don't have information about [topic] in my database." Do NOT guess.

## WHAT YOU CAN DO (encouraged)

- **Recommend courses** based on student's stream (PCM/PCB/Commerce/Arts), percentage, and eligibility criteria found in context
- **Compare programs** using data from context (fees, duration, eligibility side by side)
- **Explain eligibility** — match what the student tells you against the admission criteria in the context
- **Summarize and organize** scattered information into clear, helpful answers
- **Give honest advice** like "Based on the data I have, here are your options..." — as long as every fact comes from the context

## LANGUAGE RULES — MATCH THE USER'S LANGUAGE

- **If the user writes in English**, respond entirely in English.
- **If the user writes in Hindi (Devanagari script)**, respond entirely in Hindi (Devanagari script). Example: "DIT में B.Tech की फीस कितनी है?" → respond in Hindi.
- **If the user writes in Hinglish (Hindi words in Roman/Latin script mixed with English)**, respond in Hinglish — use Roman script with a natural mix of Hindi and English words. Example: "DIT mein placement kaisa hai?" → respond like "DIT ka placement record bahut accha hai..."
- **NEVER switch languages mid-response** unless the user mixes languages. Mirror the user's language style exactly.

## RESPONSE FORMAT

- Use **Markdown**: ## headers, **bold** for key facts, tables for structured data, bullet points for lists
- Structure: ## Answer → ## Key Details → ## Source
- Use tables for fee breakdowns and comparisons
- Always cite the source URL at the end

## WHAT YOU KNOW (from database only)
${hasContext ? context : "⚠️ No relevant information found in the database for this query."}${programListContext}`;

  // Stream the response
  const result = streamText({
    model: openai("gpt-4o-mini"),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    temperature: 0.3, // Lower temperature = more factual, less creative
  });

  return result.toUIMessageStreamResponse();
}
