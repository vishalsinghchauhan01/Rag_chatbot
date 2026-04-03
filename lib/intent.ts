/**
 * =============================================================================
 * INTENT CLASSIFIER — Routes queries to SQL, RAG, or both
 * =============================================================================
 *
 * WHY THIS EXISTS:
 *   "What is the fee for B.Tech CSE?" needs EXACT numbers from SQL.
 *   "Tell me about campus life" needs narrative context from RAG (vector search).
 *   "Am I eligible for B.Tech with 72% in PCM?" needs BOTH.
 *
 * HOW IT WORKS:
 *   1. Regex patterns match against the user's query (zero API cost)
 *   2. Returns an intent with: type, source (sql/rag/both), and extracted entities
 *   3. The route handler uses this to decide which data fetchers to call
 *
 * COST: $0.00 — pure regex, no LLM calls
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type DataSource = "sql" | "rag" | "both";

export type IntentType =
  | "fee_inquiry"
  | "eligibility_check"
  | "course_list"
  | "course_detail"
  | "hostel_inquiry"
  | "transport_inquiry"
  | "scholarship_inquiry"
  | "exam_guidance"
  | "career_guidance"
  | "cost_of_living"
  | "college_info"
  | "board_guidance"
  | "comparison"
  | "general";

export interface DetectedIntent {
  type: IntentType;
  source: DataSource;
  confidence: "high" | "medium" | "low";
  entities: {
    course?: string;
    stream?: string;
    percentage?: number;
    board?: string;
    exam?: string;
    hostelType?: string;
    career?: string;
    city?: string;
  };
  ragCategories?: string | string[];
}

// -----------------------------------------------------------------------------
// ENTITY EXTRACTORS
// -----------------------------------------------------------------------------

function extractPercentage(q: string): number | undefined {
  const match = q.match(/(\d{1,3})\s*(%|percent|marks)/i);
  return match ? parseInt(match[1]) : undefined;
}

function extractStream(q: string): string | undefined {
  if (/\bpcm\b|physics.*chemistry.*math/i.test(q)) return "PCM";
  if (/\bpcb\b|physics.*chemistry.*bio/i.test(q)) return "PCB";
  if (/\bcommerce\b|accounts|business/i.test(q)) return "Commerce";
  if (/\barts\b|\bhumanities\b/i.test(q)) return "Humanities";
  if (/\bscience\b/i.test(q)) return "Science";
  return undefined;
}

function extractBoard(q: string): string | undefined {
  if (/\bcbse\b/i.test(q)) return "CBSE";
  if (/\bicse\b|\bisc\b/i.test(q)) return "ICSE";
  if (/\buttarakhand\s*board\b|\bukboard\b/i.test(q)) return "Uttarakhand Board";
  if (/\bstate\s*board\b/i.test(q)) return "State Board";
  return undefined;
}

function extractCourse(q: string): string | undefined {
  // Match common course patterns — order matters (longer matches first)
  const patterns: [RegExp, string][] = [
    [/\bb\.?\s*tech\s+cse\b|\bcs[e]?\s+engineering\b|\bcomputer\s+science\b/i, "btech-cse"],
    [/\bb\.?\s*tech\s+it\b|\binformation\s+technology\b/i, "btech-it"],
    [/\bb\.?\s*tech\s+civil\b|\bcivil\s+engineering\b/i, "btech-civil"],
    [/\bb\.?\s*tech\s+mech\b|\bmechanical\s+engineering\b/i, "btech-mechanical"],
    [/\bb\.?\s*tech\s+(?:ece|electronics)\b|\belectronics.*communication\b/i, "btech-ece"],
    [/\bb\.?\s*tech\s+(?:eee|electrical)\b|\belectrical\s+engineering\b/i, "btech-eee"],
    [/\bb\.?\s*tech\s+ai\b|\bartificial\s+intelligence\b/i, "btech-ai-ml"],
    [/\bb\.?\s*tech\s+cyber\b|\bcyber\s*security\b/i, "btech-cyber-security"],
    [/\bb\.?\s*tech\s+petro\b|\bpetroleum\s+engineering\b/i, "btech-petroleum"],
    [/\bb\.?\s*tech\b/i, "btech"],
    [/\bb\.?\s*arch\b|\barchitecture\b/i, "barch"],
    [/\bb\.?\s*des\b|\bdesign\b/i, "bdes"],
    [/\bb\.?\s*pharm\b|\bpharmacy\b/i, "bpharm"],
    [/\bb\.?\s*sc\b|\bbsc\b/i, "bsc"],
    [/\bb\.?\s*a\b\s+(?!\.)/i, "ba"],
    [/\bmba\b/i, "mba"],
    [/\bmca\b/i, "mca"],
    [/\bm\.?\s*tech\b/i, "mtech"],
    [/\bm\.?\s*pharm\b/i, "mpharm"],
    [/\bm\.?\s*sc\b|\bmsc\b/i, "msc"],
    [/\bm\.?\s*a\b/i, "ma"],
    [/\bphd\b|\bdoctoral\b/i, "phd"],
    [/\bbba\b/i, "bba"],
    [/\bbca\b/i, "bca"],
    [/\blateral\s*entry\b/i, "lateral-entry"],
  ];

  for (const [regex, slug] of patterns) {
    if (regex.test(q)) return slug;
  }
  return undefined;
}

function extractExam(q: string): string | undefined {
  const exams: [RegExp, string][] = [
    [/\bjee\s*main\b/i, "JEE Main"],
    [/\bjee\s*advanced\b/i, "JEE Advanced"],
    [/\bcuet\s*ug\b|\bcuet\b/i, "CUET UG"],
    [/\bneet\b/i, "NEET"],
    [/\bnata\b/i, "NATA"],
    [/\bbitsat\b/i, "BITSAT"],
    [/\buksee\b/i, "UKSEE"],
    [/\bgate\b/i, "GATE"],
    [/\bcat\b(?!\s*egory)/i, "CAT"],
    [/\bmat\b/i, "MAT"],
    [/\bxat\b/i, "XAT"],
    [/\bcmat\b/i, "CMAT"],
    [/\bgpat\b/i, "GPAT"],
    [/\bjee\b/i, "JEE Main"],
  ];

  for (const [regex, name] of exams) {
    if (regex.test(q)) return name;
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// INTENT DETECTION — Pattern matching (ordered by specificity)
// -----------------------------------------------------------------------------

export function detectIntent(question: string): DetectedIntent {
  const q = question.toLowerCase();

  const entities: DetectedIntent["entities"] = {
    course: extractCourse(q),
    stream: extractStream(q),
    percentage: extractPercentage(q),
    board: extractBoard(q),
    exam: extractExam(q),
  };

  // --- ELIGIBILITY CHECK (highest priority — needs both SQL + RAG) ---
  // "Am I eligible for B.Tech?", "Can I get admission with 60%?", "72% PCM eligible?"
  if (
    q.match(
      /(?:eligible|eligib|can\s+i\s+(?:get|take|join|apply|do)|(?:am\s+i|i\s+am).*(?:eligible|qualify)|what.*(?:course|branch|program).*(?:can\s+i|for\s+me)|(?:mere|mera|muje|mujhe).*(?:mil|admission)|kya.*(?:eligible|qualify|admission)|(?:got|have|scored).*(?:\d+\s*%|percent|marks).*(?:which|what|can)|(?:which|what).*(?:course|branch).*(?:\d+\s*%|percent))/i
    )
  ) {
    return {
      type: "eligibility_check",
      source: "sql",
      confidence: entities.percentage || entities.stream ? "high" : "medium",
      entities,
    };
  }

  // --- FEE INQUIRY (SQL for exact numbers) ---
  // "What is the fee for B.Tech CSE?", "kitni fees hai?", "total cost?"
  // NOTE: "hostel fees" is handled by hostel_inquiry below, so we exclude hostel-related terms here
  if (
    q.match(
      /(?:fee|fees|tuition|cost\s+of\s+(?:course|program|degree|btech|mba)|kitni?\s*fee|total\s+fee|year\s*(?:wise|1|2|3|4)\s*fee|semester\s*fee|annual\s*fee|(?:how\s+much|what).*(?:fee|cost|charge|pay).*(?:course|program|btech|mba|mca))/i
    ) &&
    !q.match(/hostel|mess|laundry|accommodation|room|pg\s+near|paying\s*guest/i)
  ) {
    return {
      type: "fee_inquiry",
      source: "sql",
      confidence: entities.course ? "high" : "medium",
      entities,
      ragCategories: ["admissions", "courses"],
    };
  }

  // --- SCHOLARSHIP INQUIRY (SQL) ---
  if (
    q.match(
      /(?:scholarship|fee\s*waiver|fee\s*concession|discount\s+on\s+fee|merit\s*(?:based|scholarship)|financial\s+aid|free\s*ship|(?:defence|defense|military|army|navy|air\s*force).*(?:quota|scholarship|discount)|sibling\s*discount|girl\s*(?:scholarship|discount|concession))/i
    )
  ) {
    return {
      type: "scholarship_inquiry",
      source: "sql",
      confidence: "high",
      entities,
    };
  }

  // --- HOSTEL INQUIRY (SQL for fees/details) ---
  if (
    q.match(
      /(?:hostel|hostal|room|accommodation|mess\s*fee|laundry|pg\s+near|paying\s*guest|boy[s']?\s*hostel|girl[s']?\s*hostel|day\s*scholar|hostler|residential)/i
    )
  ) {
    entities.hostelType = /girl|female|women|ladies/i.test(q)
      ? "girls"
      : /boy|male|men|gents/i.test(q)
        ? "boys"
        : undefined;
    return {
      type: "hostel_inquiry",
      source: "both",
      confidence: "high",
      entities,
      ragCategories: "campus",
    };
  }

  // --- TRANSPORT INQUIRY (SQL) ---
  if (
    q.match(
      /(?:transport|bus\s*(?:service|route|fee|facility)|college\s*bus|auto|cab|how\s+to\s+reach|commute|travel|conveyance|pickup\s*point|distance\s+from)/i
    )
  ) {
    return {
      type: "transport_inquiry",
      source: "both",
      confidence: "high",
      entities,
      ragCategories: "campus",
    };
  }

  // --- COST OF LIVING (SQL — cities table) ---
  if (
    q.match(
      /(?:cost\s+of\s+living|monthly\s*(?:expense|cost|budget|kharcha)|rent|pg\s+rent|food\s+cost|living\s+(?:cost|expense)|dehradun\s+(?:cost|expense|rent)|(?:kitna|kitni)\s*(?:kharcha|paisa|expense)|affordable|cheap|budget\s+for\s+student)/i
    )
  ) {
    entities.city = /dehradun|doon/i.test(q) ? "Dehradun" : undefined;
    return {
      type: "cost_of_living",
      source: "sql",
      confidence: "high",
      entities,
    };
  }

  // --- EXAM GUIDANCE (SQL — exams table) ---
  if (
    q.match(
      /(?:entrance\s*exam|which\s*exam|exam\s+(?:for|required|needed|prepare)|preparation|prep\s+time|exam\s+date|registration\s+date|how\s+to\s+prepare|syllabus\s+of\s+(?:jee|neet|cuet|gate|cat)|(?:jee|neet|cuet|gate|cat|nata|bitsat|uksee|gpat).*(?:eligib|prepare|when|date|difficult|tips|about|detail|info|kya|tell|exam))/i
    )
  ) {
    return {
      type: "exam_guidance",
      source: "sql",
      confidence: entities.exam ? "high" : "medium",
      entities,
    };
  }

  // --- BOARD GUIDANCE (SQL — boards table) ---
  if (
    q.match(
      /(?:(?:cbse|icse|state\s*board|uttarakhand\s*board).*(?:stream|subject|career|option|after|scope)|which\s+board|board\s+(?:difference|comparison|better|vs)|(?:after|with)\s+(?:cbse|icse)|(?:stream|subject)\s+(?:in|of|for)\s+(?:cbse|icse|12th))/i
    )
  ) {
    return {
      type: "board_guidance",
      source: "sql",
      confidence: "high",
      entities,
    };
  }

  // --- CAREER GUIDANCE (SQL — career_paths table) ---
  if (
    q.match(
      /(?:career|job|scope|future|(?:kya|what)\s+(?:banu|ban\s*sakta|become)|salary|package|(?:after|with)\s+(?:btech|mba|bca|mca|bsc|bpharm).*(?:career|job|scope|future)|software\s*engineer|data\s*scientist|doctor|pharmacist|chartered\s*accountant|(?:best|top)\s+career)/i
    )
  ) {
    return {
      type: "career_guidance",
      source: "sql",
      confidence: entities.stream || entities.course ? "high" : "medium",
      entities,
    };
  }

  // --- COURSE LIST (SQL for structured list) ---
  if (
    q.match(
      /(?:(?:all|list|total|how\s+many|kitne|kaun|saare|sab|kya\s+kya).*(?:course|program|branch|department)|courses?\s*(?:offered|available)|(?:ug|pg|undergraduate|postgraduate|bachelor|master)\s*(?:course|program))/i
    )
  ) {
    return {
      type: "course_list",
      source: "sql",
      confidence: "high",
      entities,
    };
  }

  // --- COURSE DETAIL (SQL + RAG for rich info) ---
  if (entities.course && q.match(/(?:about|detail|tell|info|kya\s+hai|bata)/i)) {
    return {
      type: "course_detail",
      source: "both",
      confidence: "high",
      entities,
      ragCategories: "courses",
    };
  }

  // --- COLLEGE INFO (SQL for metadata, RAG for narrative) ---
  if (
    q.match(
      /(?:about\s+(?:dit|college|university)|(?:dit|college).*(?:rank|naac|nirf|accredit|established|campus\s+area)|where\s+is\s+(?:dit|college)|location|address|contact|phone|email|website|founded|established)/i
    )
  ) {
    return {
      type: "college_info",
      source: "both",
      confidence: "high",
      entities,
      ragCategories: "about",
    };
  }

  // --- COMPARISON (needs SQL for structured compare) ---
  if (
    q.match(
      /(?:compare|vs\.?|versus|difference\s+between|better|(?:which\s+is)\s+(?:better|best)|hostel\s+vs\s+day|boy.*vs.*girl)/i
    )
  ) {
    return {
      type: "comparison",
      source: "both",
      confidence: "medium",
      entities,
      ragCategories: entities.course ? "courses" : undefined,
    };
  }

  // --- FALLBACK: General query → RAG only ---
  // Uses the existing detectQueryCategory logic for RAG category routing
  const ragCat = detectRagCategory(q);
  return {
    type: "general",
    source: "rag",
    confidence: "low",
    entities,
    ragCategories: ragCat,
  };
}

// -----------------------------------------------------------------------------
// RAG CATEGORY DETECTION (preserved from original route.ts logic)
// -----------------------------------------------------------------------------

function detectRagCategory(q: string): string | string[] | undefined {
  if (
    q.match(
      /what.*(course|branch|program|stream).*(?:take|join|choose|do|get|select)|(?:which|suggest|recommend).*(course|branch|program)|i\s+(?:got|have|scored|completed|passed).*%|pcm|pcb|commerce|arts|science.*stream|12th|12|10\+2|intermediate|hsc/
    )
  )
    return ["courses", "admissions"];

  if (q.match(/place|package|salary|recruit|lpa|ctc|hire|offer|company|compan/))
    return "placements";
  if (q.match(/fee|cost|scholarship|tuition|expense|payment|refund|loan/))
    return ["admissions", "courses"];
  if (q.match(/admiss|eligib|apply|entrance|cutoff|jee|cuet|counseli/))
    return "admissions";
  if (
    q.match(
      /course|program|syllab|branch|b\.?tech|m\.?tech|mba|mca|bca|b\.?arch|phd|doctoral|bsc|msc|b\.?pharm/
    )
  )
    return "courses";
  if (q.match(/facult|professor|teacher|hod|dean|staff/)) return "faculty";
  if (
    q.match(
      /hostel|campus|facilit|library|lab|sport|canteen|mess|gym|transport/
    )
  )
    return "campus";
  if (q.match(/research|patent|publication|journal|paper/)) return "research";
  if (q.match(/about|history|rank|naac|nirf|accredit|vision|mission|founder/))
    return "about";

  return undefined;
}
