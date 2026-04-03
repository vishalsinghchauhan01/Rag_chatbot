import { openai } from "@ai-sdk/openai";
import { streamText, convertToModelMessages } from "ai";
import { smartSearch, getAllPrograms } from "@/lib/db";
import { detectIntent } from "@/lib/intent";
import { getStructuredContext } from "@/lib/structured-queries";

// =============================================================================
// EMBEDDING — Convert user question to vector for RAG search
// =============================================================================

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

// =============================================================================
// POST HANDLER — Intent-based routing: SQL + RAG hybrid
// =============================================================================
//
// HOW IT WORKS:
//   1. User sends a question
//   2. Intent classifier detects what they're asking (fee? eligibility? hostel?)
//   3. Based on intent.source:
//      - "sql"  → Only fetch structured data (exact numbers, no embedding needed)
//      - "rag"  → Only fetch RAG context (narrative/descriptive content)
//      - "both" → Fetch BOTH and merge them
//   4. All context is injected into the system prompt
//   5. LLM generates answer using ONLY the provided context
//
// COST OPTIMIZATION:
//   - SQL-only queries skip the embedding API call (~30% cheaper)
//   - Intent detection is pure regex ($0.00)
//   - Only the LLM call costs money
// =============================================================================

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

  // =========================================================================
  // STEP 1: Detect intent (zero cost — pure regex)
  // =========================================================================
  const intent = detectIntent(question);

  // =========================================================================
  // STEP 2: Fetch data based on intent source
  // =========================================================================
  let structuredContext = "";
  let ragContext = "";
  let programListContext = "";

  // SQL context — structured data (fees, eligibility, hostels, etc.)
  if (intent.source === "sql" || intent.source === "both") {
    structuredContext = await getStructuredContext(intent, university);
  }

  // RAG context — narrative data (campus life, placements, general info)
  if (intent.source === "rag" || intent.source === "both") {
    // Use intent's ragCategories for targeted search, fallback to undefined for global
    const ragCategories = intent.ragCategories;

    const questionEmbedding = await embedQuestion(question);
    const relevantChunks = await smartSearch(
      questionEmbedding,
      university,
      ragCategories
    );

    ragContext = relevantChunks
      .map(
        (
          chunk: {
            content: string;
            source: string;
            category: string;
            similarity: number;
          },
          i: number
        ) =>
          `[Source ${i + 1}] (${chunk.category}) ${chunk.source}\n${chunk.content}`
      )
      .join("\n\n---\n\n");
  }

  // Course list — for "list all courses" type queries (now from SQL too)
  if (intent.type === "course_list") {
    // structuredContext already has the full list from getCourseList()
    // But also grab the old RAG-based program list as a fallback
    const programs = await getAllPrograms(university);
    if (programs.length > 0) {
      programListContext = `\n\n## COMPLETE LIST FROM RAG INDEX (${programs.length} programs)\n${programs.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
    }
  }

  // =========================================================================
  // STEP 3: Build the system prompt with all context
  // =========================================================================
  const hasStructured = structuredContext.length > 0;
  const hasRag = ragContext.length > 0;
  const hasAnyContext = hasStructured || hasRag || programListContext.length > 0;

  // Build context section based on what data we have
  let contextSection = "";

  if (hasStructured) {
    contextSection += `## STRUCTURED DATA (exact numbers from database — use these for fees, eligibility, costs)\n\n${structuredContext}\n\n`;
  }

  if (hasRag) {
    contextSection += `## NARRATIVE DATA (from university website — use for descriptions, campus life, placements)\n\n${ragContext}\n\n`;
  }

  if (programListContext) {
    contextSection += programListContext;
  }

  if (!hasAnyContext) {
    contextSection = "No relevant information found in the database for this query.";
  }

  const systemPrompt = `You are a friendly and helpful student guidance counselor for Uttarakhand universities. You help students with admissions, course selection, eligibility, fees, scholarships, hostels, transport, career guidance, exam preparation, and cost of living. You answer questions using ONLY the data provided below. You are NOT a general knowledge assistant.

## CORE RULES

1. **All facts, numbers, names, and statistics MUST come from the context below.** Do NOT invent any data. Do NOT use your training data for university-specific information.
2. **You CAN reason, recommend, and advise** based on the context data. If a student says "I scored 60% in PCM, what course can I take?", look at the eligibility criteria in the context and recommend matching courses. This is reasoning, not hallucination.
3. **NEVER answer about universities/institutions NOT in the context.** If someone asks about IIT Roorkee, Harvard, or any institution not in the context, say: "I don't have data for that institution in my database."
4. **When showing fee data**, present ONLY the exact numbers from the context. Do NOT mix "ALL INDIA CATEGORY" with "UTTARAKHAND/HIMALAYAN STATE CATEGORY" — they are completely different fee structures.
5. **Do NOT reformat, round, or recalculate any numbers.** Show them exactly as they appear.
6. **If the context has NO relevant information for the question**, say: "I don't have information about [topic] in my database." Do NOT guess.
7. **ANTI-HALLUCINATION (CRITICAL):** If a user says "you missed X", "what about X?", or suggests a course/program/hostel/fact that is NOT in the context data above, you MUST say "I don't have information about [X] in my database." NEVER confirm, add, or fabricate data just because the user mentioned it. The user may be testing you. Only data explicitly present in the context sections above is real.
8. **STRUCTURED DATA takes priority over NARRATIVE DATA** when both are present. Structured data has exact numbers from the database. Narrative data provides additional context and descriptions.
9. **For eligibility questions**, clearly state whether the student IS or IS NOT eligible, and list ALL matching courses. If they don't meet criteria, explain what's missing.
10. **For scholarship questions**, show all applicable scholarships and help calculate potential savings.
11. **For cost of living questions**, provide budget breakdowns with monthly estimates.

## WHAT YOU CAN DO (encouraged)

- **Recommend courses** based on student's stream (PCM/PCB/Commerce/Arts), percentage, and eligibility criteria found in context
- **Compare programs** using data from context (fees, duration, eligibility side by side)
- **Explain eligibility** — match what the student tells you against the admission criteria in the context
- **Calculate total costs** — add up fees + hostel + living expenses for a complete picture
- **Suggest scholarships** — match student's profile to available scholarship criteria
- **Guide exam preparation** — explain which exams to take, difficulty level, prep time
- **Career counseling** — suggest career paths based on stream, with salary expectations
- **Summarize and organize** scattered information into clear, helpful answers
- **Give honest advice** like "Based on the data I have, here are your options..." — as long as every fact comes from the context

## LANGUAGE RULES — MATCH THE USER'S LANGUAGE

- **If the user writes in English**, respond entirely in English.
- **If the user writes in Hindi (Devanagari script)**, respond entirely in Hindi (Devanagari script). Example: "DIT mein B.Tech ki fees kitni hai?" → respond in Hindi.
- **If the user writes in Hinglish (Hindi words in Roman/Latin script mixed with English)**, respond in Hinglish — use Roman script with a natural mix of Hindi and English words. Example: "DIT mein placement kaisa hai?" → respond like "DIT ka placement record bahut accha hai..."
- **NEVER switch languages mid-response** unless the user mixes languages. Mirror the user's language style exactly.

## RESPONSE FORMAT

- Use **Markdown**: ## headers, **bold** for key facts, tables for structured data, bullet points for lists
- Structure: ## Answer → ## Key Details → ## Source (if applicable)
- Use tables for fee breakdowns, comparisons, and eligibility summaries
- For eligibility answers, use a clear YES/NO verdict followed by details
- For cost questions, show itemized breakdowns

## DETECTED INTENT: ${intent.type} (confidence: ${intent.confidence}, source: ${intent.source})

## WHAT YOU KNOW (from database only)
${contextSection}`;

  // =========================================================================
  // STEP 4: Stream the LLM response
  // =========================================================================
  // Convert messages — handle both UIMessage format (from useChat) and simple format (from curl/API)
  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages);
  } catch {
    // Fallback: if convertToModelMessages fails, build simple messages
    modelMessages = messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content || "",
    }));
  }

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system: systemPrompt,
    messages: modelMessages,
    temperature: 0.3, // Lower temperature = more factual, less creative
  });

  return result.toUIMessageStreamResponse();
}
