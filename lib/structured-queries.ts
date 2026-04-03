/**
 * =============================================================================
 * STRUCTURED QUERY FUNCTIONS — SQL queries for exact data retrieval
 * =============================================================================
 *
 * WHY THIS EXISTS:
 *   The RAG system (vector search) is great for "Tell me about campus life."
 *   But for "What is the fee for B.Tech CSE?" — you need EXACT numbers from SQL.
 *
 *   This file contains every SQL query the chatbot needs for structured data.
 *   Each function returns formatted text that gets injected into the LLM prompt
 *   alongside (or instead of) RAG context.
 *
 * HOW IT'S USED:
 *   1. Intent classifier detects query type (e.g., "fee_inquiry")
 *   2. Route handler calls the matching function here (e.g., getCourseFees)
 *   3. Result is formatted as readable text and injected into the system prompt
 *   4. LLM uses this exact data to answer — no hallucination possible
 *
 * COST: $0.00 for SQL queries — only the LLM call costs money
 */

import { pool } from "./db";

// =============================================================================
// HELPER: Get college ID from slug
// =============================================================================

async function getCollegeId(slug: string): Promise<number | null> {
  const result = await pool.query(
    "SELECT id FROM colleges WHERE slug = $1",
    [slug]
  );
  return result.rows[0]?.id ?? null;
}

// =============================================================================
// 1. COLLEGE INFO
// =============================================================================

export async function getCollegeInfo(universitySlug: string): Promise<string> {
  const result = await pool.query(
    `SELECT * FROM colleges WHERE slug = $1`,
    [universitySlug]
  );

  if (result.rows.length === 0) return "";

  const c = result.rows[0];
  return `
## College Information (from database)

| Field | Details |
|-------|---------|
| Name | ${c.name} |
| Type | ${c.type} |
| Location | ${c.city}, ${c.state} |
| Address | ${c.address || "N/A"} |
| Pincode | ${c.pincode || "N/A"} |
| Established | ${c.established_year || "N/A"} |
| Campus Area | ${c.campus_area || "N/A"} |
| Total Students | ${c.total_students || "N/A"} |
| NAAC Grade | ${c.naac_grade || "N/A"} |
| NIRF Rank | ${c.nirf_rank ? `${c.nirf_rank} (${c.nirf_category})` : "N/A"} |
| Website | ${c.website_url || "N/A"} |
| Phone | ${c.phone || "N/A"} |
| Email | ${c.email || "N/A"} |
| Admissions Phone | ${c.admissions_phone || "N/A"} |
| Admissions Email | ${c.admissions_email || "N/A"} |
| Has Hostel | ${c.has_hostel ? "Yes" : "No"} |
| Has College Bus | ${c.has_college_bus ? "Yes" : "No"} |
| Nearest Railway Station | ${c.nearest_railway_station || "N/A"} |
| Nearest Airport | ${c.nearest_airport || "N/A"} |
| Google Maps | ${c.maps_url || "N/A"} |
`.trim();
}

// =============================================================================
// 2. COURSE LIST
// =============================================================================

export async function getCourseList(
  universitySlug: string,
  degreeLevel?: string
): Promise<string> {
  const collegeId = await getCollegeId(universitySlug);
  if (!collegeId) return "";

  let query = `
    SELECT name, slug, degree_level, duration_years, duration_note,
           fee_year1_all_india, is_lateral_entry
    FROM courses
    WHERE college_id = $1
  `;
  const params: (number | string)[] = [collegeId];

  if (degreeLevel) {
    query += ` AND degree_level = $2`;
    params.push(degreeLevel);
  }

  query += ` ORDER BY degree_level, name`;

  const result = await pool.query(query, params);

  if (result.rows.length === 0) return "";

  const levelLabel = degreeLevel || "All";
  let text = `## ${levelLabel} Courses at ${universitySlug} (${result.rows.length} programs)\n\n`;
  text += `| # | Course | Level | Duration | Year 1 Fee (All India) |\n`;
  text += `|---|--------|-------|----------|------------------------|\n`;

  result.rows.forEach((row, i) => {
    const fee = row.fee_year1_all_india
      ? `Rs ${row.fee_year1_all_india.toLocaleString("en-IN")}`
      : "N/A";
    const lateral = row.is_lateral_entry ? " (Lateral)" : "";
    const duration = row.duration_years
      ? `${row.duration_years} yrs${row.duration_note ? " " + row.duration_note : ""}`
      : "N/A";
    text += `| ${i + 1} | ${row.name}${lateral} | ${row.degree_level} | ${duration} | ${fee} |\n`;
  });

  return text.trim();
}

// =============================================================================
// 3. COURSE FEES (Detailed year-wise)
// =============================================================================

export async function getCourseFees(
  universitySlug: string,
  courseSlug?: string
): Promise<string> {
  const collegeId = await getCollegeId(universitySlug);
  if (!collegeId) return "";

  let query: string;
  let params: (number | string)[];

  if (courseSlug) {
    // Exact course match
    query = `
      SELECT name, slug, degree_level, duration_years,
             fee_year1_all_india, fee_year2_all_india, fee_year3_all_india,
             fee_year4_all_india, fee_year5_all_india,
             fee_year1_state, fee_year2_state, fee_year3_state,
             fee_year4_state, fee_year5_state
      FROM courses
      WHERE college_id = $1 AND slug LIKE $2
      ORDER BY name
    `;
    params = [collegeId, `%${courseSlug}%`];
  } else {
    // All courses
    query = `
      SELECT name, slug, degree_level, duration_years,
             fee_year1_all_india, fee_year2_all_india, fee_year3_all_india,
             fee_year4_all_india, fee_year5_all_india,
             fee_year1_state, fee_year2_state, fee_year3_state,
             fee_year4_state, fee_year5_state
      FROM courses
      WHERE college_id = $1
      ORDER BY degree_level, name
    `;
    params = [collegeId];
  }

  const result = await pool.query(query, params);
  if (result.rows.length === 0) return "";

  let text = `## Fee Structure (from database)\n\n`;

  for (const row of result.rows) {
    const years = Math.ceil(row.duration_years || 4);
    text += `### ${row.name} (${row.degree_level}, ${years} years)\n\n`;

    text += `| Year | All India Category | Uttarakhand/Himalayan State |\n`;
    text += `|------|--------------------|-----------------------------|\n`;

    let totalAI = 0;
    let totalState = 0;

    for (let y = 1; y <= years; y++) {
      const ai = row[`fee_year${y}_all_india`];
      const st = row[`fee_year${y}_state`];
      const aiStr = ai ? `Rs ${ai.toLocaleString("en-IN")}` : "N/A";
      const stStr = st ? `Rs ${st.toLocaleString("en-IN")}` : "N/A";
      text += `| Year ${y} | ${aiStr} | ${stStr} |\n`;
      if (ai) totalAI += ai;
      if (st) totalState += st;
    }

    text += `| **Total** | **Rs ${totalAI.toLocaleString("en-IN")}** | **Rs ${totalState.toLocaleString("en-IN")}** |\n\n`;
  }

  return text.trim();
}

// =============================================================================
// 4. ELIGIBILITY CHECK
// =============================================================================

export async function checkEligibility(
  universitySlug: string,
  stream?: string,
  percentage?: number,
  board?: string,
  courseSlug?: string
): Promise<string> {
  const collegeId = await getCollegeId(universitySlug);
  if (!collegeId) return "";

  let query = `
    SELECT c.name as course_name, c.slug as course_slug, c.degree_level,
           e.required_stream, e.min_percentage, e.min_percentage_reserved,
           e.accepted_boards, e.required_entrance_exams,
           e.additional_requirements, e.required_qualification, e.admission_mode
    FROM eligibility_rules e
    JOIN courses c ON c.id = e.course_id
    WHERE c.college_id = $1
  `;
  const params: (number | string)[] = [collegeId];
  let paramIndex = 2;

  // Filter by stream if provided
  if (stream) {
    query += ` AND (e.required_stream = $${paramIndex} OR e.required_stream = 'Any' OR e.required_stream IS NULL)`;
    params.push(stream);
    paramIndex++;
  }

  // Filter by percentage if provided
  if (percentage !== undefined) {
    query += ` AND (e.min_percentage IS NULL OR e.min_percentage <= $${paramIndex})`;
    params.push(percentage);
    paramIndex++;
  }

  // Filter by specific course if provided
  if (courseSlug) {
    query += ` AND c.slug LIKE $${paramIndex}`;
    params.push(`%${courseSlug}%`);
    paramIndex++;
  }

  query += ` ORDER BY c.degree_level, c.name`;

  const result = await pool.query(query, params);

  if (result.rows.length === 0) {
    let noMatchMsg = `## Eligibility Check Result\n\n`;
    noMatchMsg += `No matching courses found`;
    if (stream) noMatchMsg += ` for stream: ${stream}`;
    if (percentage) noMatchMsg += `, percentage: ${percentage}%`;
    noMatchMsg += `. The student may not meet the minimum requirements for any program, or the stream/percentage combination doesn't match available courses.`;
    return noMatchMsg;
  }

  let text = `## Eligibility Check Result (from database)\n\n`;
  if (stream) text += `**Student Stream:** ${stream}\n`;
  if (percentage) text += `**Student Percentage:** ${percentage}%\n`;
  if (board) text += `**Student Board:** ${board}\n`;
  text += `**Eligible Courses Found:** ${result.rows.length}\n\n`;

  text += `| # | Course | Level | Min % | Stream | Entrance Exams | Admission Mode |\n`;
  text += `|---|--------|-------|-------|--------|----------------|----------------|\n`;

  result.rows.forEach((row, i) => {
    const minPct = row.min_percentage ? `${row.min_percentage}%` : "N/A";
    const exams = row.required_entrance_exams
      ? row.required_entrance_exams.join(", ")
      : "Direct";
    const mode = row.admission_mode
      ? row.admission_mode.substring(0, 60) + (row.admission_mode.length > 60 ? "..." : "")
      : "N/A";
    text += `| ${i + 1} | ${row.course_name} | ${row.degree_level} | ${minPct} | ${row.required_stream || "Any"} | ${exams} | ${mode} |\n`;
  });

  // Add detailed info for top 5 matches
  text += `\n### Detailed Eligibility for Top Matches\n\n`;
  for (const row of result.rows.slice(0, 5)) {
    text += `**${row.course_name}**\n`;
    text += `- Required Stream: ${row.required_stream || "Any"}\n`;
    text += `- Min Percentage (General): ${row.min_percentage || "N/A"}%\n`;
    if (row.min_percentage_reserved)
      text += `- Min Percentage (Reserved): ${row.min_percentage_reserved}%\n`;
    text += `- Accepted Boards: ${row.accepted_boards ? row.accepted_boards.join(", ") : "All"}\n`;
    text += `- Entrance Exams: ${row.required_entrance_exams ? row.required_entrance_exams.join(", ") : "None (Direct Admission)"}\n`;
    if (row.required_qualification)
      text += `- Required Qualification: ${row.required_qualification}\n`;
    if (row.additional_requirements)
      text += `- Additional Requirements: ${row.additional_requirements}\n`;
    if (row.admission_mode)
      text += `- Admission Mode: ${row.admission_mode}\n`;
    text += `\n`;
  }

  return text.trim();
}

// =============================================================================
// 5. HOSTEL INFORMATION
// =============================================================================

export async function getHostels(
  universitySlug: string,
  hostelType?: string
): Promise<string> {
  const collegeId = await getCollegeId(universitySlug);
  if (!collegeId) return "";

  let query = `
    SELECT type, name, room_type,
           hostel_fee_annual, mess_fee_annual, laundry_fee_annual,
           total_annual, security_deposit,
           ac_available, wifi_included, gym_included,
           amenities, total_capacity, food_type, notes
    FROM hostels
    WHERE college_id = $1
  `;
  const params: (number | string)[] = [collegeId];

  if (hostelType) {
    query += ` AND type = $2`;
    params.push(hostelType);
  }

  query += ` ORDER BY type, room_type`;

  const result = await pool.query(query, params);
  if (result.rows.length === 0) return "";

  let text = `## Hostel Information (from database)\n\n`;

  text += `| Hostel | Type | Room | Hostel Fee | Mess Fee | Laundry | Total/Year | Deposit |\n`;
  text += `|--------|------|------|------------|----------|---------|------------|----------|\n`;

  for (const h of result.rows) {
    text += `| ${h.name || "N/A"} | ${h.type} | ${h.room_type} | Rs ${(h.hostel_fee_annual || 0).toLocaleString("en-IN")} | Rs ${(h.mess_fee_annual || 0).toLocaleString("en-IN")} | Rs ${(h.laundry_fee_annual || 0).toLocaleString("en-IN")} | **Rs ${(h.total_annual || 0).toLocaleString("en-IN")}** | Rs ${(h.security_deposit || 0).toLocaleString("en-IN")} |\n`;
  }

  text += `\n### Hostel Details\n\n`;
  for (const h of result.rows) {
    text += `**${h.name || h.type} Hostel** (${h.type}, ${h.room_type} seater)\n`;
    text += `- Total Annual Cost: Rs ${(h.total_annual || 0).toLocaleString("en-IN")}\n`;
    text += `- AC: ${h.ac_available ? "Yes" : "No"} | WiFi: ${h.wifi_included ? "Yes" : "No"} | Gym: ${h.gym_included ? "Yes" : "No"}\n`;
    text += `- Food Type: ${h.food_type || "N/A"}\n`;
    if (h.amenities && h.amenities.length > 0)
      text += `- Amenities: ${h.amenities.join(", ")}\n`;
    if (h.total_capacity) text += `- Capacity: ${h.total_capacity} students\n`;
    if (h.notes) text += `- Note: ${h.notes}\n`;
    text += `\n`;
  }

  return text.trim();
}

// =============================================================================
// 6. TRANSPORT OPTIONS
// =============================================================================

export async function getTransport(universitySlug: string): Promise<string> {
  const collegeId = await getCollegeId(universitySlug);
  if (!collegeId) return "";

  const result = await pool.query(
    `SELECT mode, description, monthly_cost, route_details, pickup_points, frequency
     FROM transport_options
     WHERE college_id = $1
     ORDER BY mode`,
    [collegeId]
  );

  if (result.rows.length === 0) return "";

  let text = `## Transport Options (from database)\n\n`;

  text += `| Mode | Monthly Cost | Frequency |\n`;
  text += `|------|--------------|----------|\n`;

  for (const t of result.rows) {
    const cost = t.monthly_cost
      ? `Rs ${t.monthly_cost.toLocaleString("en-IN")}`
      : "Variable";
    text += `| ${t.mode} | ${cost} | ${t.frequency || "N/A"} |\n`;
  }

  text += `\n### Transport Details\n\n`;
  for (const t of result.rows) {
    text += `**${t.mode.replace(/_/g, " ").toUpperCase()}**\n`;
    text += `- ${t.description}\n`;
    if (t.monthly_cost)
      text += `- Monthly Cost: Rs ${t.monthly_cost.toLocaleString("en-IN")}\n`;
    if (t.route_details) text += `- Route: ${t.route_details}\n`;
    if (t.pickup_points && t.pickup_points.length > 0)
      text += `- Pickup Points: ${t.pickup_points.join(", ")}\n`;
    if (t.frequency) text += `- Frequency: ${t.frequency}\n`;
    text += `\n`;
  }

  return text.trim();
}

// =============================================================================
// 7. SCHOLARSHIPS
// =============================================================================

export async function getScholarships(
  universitySlug: string,
  percentage?: number,
  program?: string
): Promise<string> {
  const collegeId = await getCollegeId(universitySlug);
  if (!collegeId) return "";

  const result = await pool.query(
    `SELECT name, scholarship_type, scholarship_percentage, scholarship_amount,
            applied_on, criteria, applicable_programs, duration,
            renewal_criteria, stackable, notes
     FROM scholarships
     WHERE college_id = $1
     ORDER BY scholarship_percentage DESC NULLS LAST, name`,
    [collegeId]
  );

  if (result.rows.length === 0) return "";

  let text = `## Scholarships Available (from database)\n\n`;

  text += `| # | Scholarship | Discount | Applied On | For Programs | Duration |\n`;
  text += `|---|-------------|----------|------------|-------------|----------|\n`;

  result.rows.forEach((s, i) => {
    const discount = s.scholarship_percentage
      ? `${s.scholarship_percentage}%`
      : s.scholarship_amount
        ? `Rs ${s.scholarship_amount.toLocaleString("en-IN")}`
        : "N/A";
    const programs = s.applicable_programs
      ? s.applicable_programs.join(", ")
      : "All";
    text += `| ${i + 1} | ${s.name} | ${discount} | ${s.applied_on} | ${programs} | ${s.duration || "N/A"} |\n`;
  });

  text += `\n### Scholarship Details\n\n`;
  for (const s of result.rows) {
    text += `**${s.name}**\n`;
    text += `- Type: ${s.scholarship_type || "N/A"}\n`;
    text += `- Discount: ${s.scholarship_percentage ? s.scholarship_percentage + "% off " + s.applied_on : "Rs " + (s.scholarship_amount || 0).toLocaleString("en-IN")}\n`;
    text += `- Criteria: ${s.criteria}\n`;
    text += `- Programs: ${s.applicable_programs ? s.applicable_programs.join(", ") : "All"}\n`;
    if (s.duration) text += `- Duration: ${s.duration}\n`;
    if (s.renewal_criteria) text += `- Renewal: ${s.renewal_criteria}\n`;
    text += `- Stackable: ${s.stackable ? "Yes (can combine with other scholarships)" : "No"}\n`;
    if (s.notes) text += `- Note: ${s.notes}\n`;
    text += `\n`;
  }

  return text.trim();
}

// =============================================================================
// 8. COST OF LIVING
// =============================================================================

export async function getCostOfLiving(city?: string): Promise<string> {
  let query = `SELECT * FROM cities`;
  const params: string[] = [];

  if (city) {
    query += ` WHERE LOWER(name) = LOWER($1)`;
    params.push(city);
  }

  const result = await pool.query(query, params);
  if (result.rows.length === 0) return "";

  let text = `## Cost of Living (from database)\n\n`;

  for (const c of result.rows) {
    text += `### ${c.name}, ${c.state} (${c.tier?.replace("tier", "Tier ")})\n\n`;

    text += `#### Monthly Rent\n`;
    text += `| Accommodation | Min | Max |\n`;
    text += `|--------------|-----|-----|\n`;
    text += `| PG (Paying Guest) | Rs ${(c.rent_pg_min || 0).toLocaleString("en-IN")} | Rs ${(c.rent_pg_max || 0).toLocaleString("en-IN")} |\n`;
    text += `| Shared Room/Flat | Rs ${(c.rent_shared_min || 0).toLocaleString("en-IN")} | Rs ${(c.rent_shared_max || 0).toLocaleString("en-IN")} |\n`;
    text += `| 1BHK Apartment | Rs ${(c.rent_1bhk_min || 0).toLocaleString("en-IN")} | Rs ${(c.rent_1bhk_max || 0).toLocaleString("en-IN")} |\n\n`;

    text += `#### Monthly Food\n`;
    text += `| Type | Cost |\n`;
    text += `|------|------|\n`;
    text += `| Mess/Canteen | Rs ${(c.food_mess_monthly || 0).toLocaleString("en-IN")} |\n`;
    text += `| Eating Outside Daily | Rs ${(c.food_outside_monthly || 0).toLocaleString("en-IN")} |\n`;
    text += `| Self-Cooking | Rs ${(c.food_cooking_monthly || 0).toLocaleString("en-IN")} |\n\n`;

    text += `#### Monthly Transport\n`;
    text += `| Mode | Cost |\n`;
    text += `|------|------|\n`;
    text += `| Bus Pass | Rs ${(c.transport_bus_pass || 0).toLocaleString("en-IN")} |\n`;
    text += `| Auto/Rickshaw Daily | Rs ${(c.transport_auto_daily || 0).toLocaleString("en-IN")} |\n`;
    text += `| Bike Fuel | Rs ${(c.transport_bike_fuel || 0).toLocaleString("en-IN")} |\n\n`;

    text += `#### Miscellaneous: Rs ${(c.misc_monthly || 0).toLocaleString("en-IN")}/month\n`;
    text += `(Internet, laundry, phone, stationery, personal)\n\n`;

    // Budget estimates
    const budgetMin = (c.rent_pg_min || 0) + (c.food_mess_monthly || 0) + (c.transport_bus_pass || 0) + (c.misc_monthly || 0);
    const budgetMax = (c.rent_1bhk_max || 0) + (c.food_outside_monthly || 0) + (c.transport_auto_daily || 0) + (c.misc_monthly || 0);
    const budgetMid = (c.rent_shared_min || 0) + (c.food_cooking_monthly || 0) + (c.transport_bus_pass || 0) + (c.misc_monthly || 0);

    text += `#### Estimated Monthly Budgets (excluding college fees)\n`;
    text += `| Lifestyle | Estimate |\n`;
    text += `|-----------|----------|\n`;
    text += `| Budget (PG + Mess + Bus) | Rs ${budgetMin.toLocaleString("en-IN")}/month |\n`;
    text += `| Moderate (Shared + Cooking + Bus) | Rs ${budgetMid.toLocaleString("en-IN")}/month |\n`;
    text += `| Comfortable (1BHK + Outside + Auto) | Rs ${budgetMax.toLocaleString("en-IN")}/month |\n\n`;

    if (c.notes) text += `**Note:** ${c.notes}\n\n`;
  }

  return text.trim();
}

// =============================================================================
// 9. EXAM GUIDANCE
// =============================================================================

export async function getExamInfo(
  examName?: string,
  stream?: string,
  universitySlug?: string
): Promise<string> {
  let query: string;
  let params: string[];

  if (examName) {
    // Specific exam info
    query = `
      SELECT e.*,
             ARRAY_AGG(DISTINCT col.name) FILTER (WHERE col.name IS NOT NULL) as accepting_colleges
      FROM exams e
      LEFT JOIN exam_college_map ecm ON e.id = ecm.exam_id
      LEFT JOIN colleges col ON ecm.college_id = col.id
      WHERE LOWER(e.name) = LOWER($1) OR LOWER(e.full_name) LIKE LOWER($1)
      GROUP BY e.id
    `;
    params = [examName];
  } else if (stream) {
    // Exams for a stream
    query = `
      SELECT e.*,
             ARRAY_AGG(DISTINCT col.name) FILTER (WHERE col.name IS NOT NULL) as accepting_colleges
      FROM exams e
      LEFT JOIN exam_college_map ecm ON e.id = ecm.exam_id
      LEFT JOIN colleges col ON ecm.college_id = col.id
      WHERE $1 = ANY(e.eligible_streams) OR 'Any' = ANY(e.eligible_streams)
      GROUP BY e.id
      ORDER BY e.difficulty DESC NULLS LAST, e.name
    `;
    params = [stream];
  } else {
    // All exams
    query = `
      SELECT e.*,
             ARRAY_AGG(DISTINCT col.name) FILTER (WHERE col.name IS NOT NULL) as accepting_colleges
      FROM exams e
      LEFT JOIN exam_college_map ecm ON e.id = ecm.exam_id
      LEFT JOIN colleges col ON ecm.college_id = col.id
      GROUP BY e.id
      ORDER BY e.exam_level, e.name
    `;
    params = [];
  }

  const result = await pool.query(query, params);
  if (result.rows.length === 0) return "";

  let text = `## Entrance Exam Information (from database)\n\n`;

  if (result.rows.length === 1) {
    // Detailed view for single exam
    const ex = result.rows[0];
    text += `### ${ex.name} — ${ex.full_name || ""}\n\n`;
    text += `| Field | Details |\n`;
    text += `|-------|--------|\n`;
    text += `| Conducting Body | ${ex.conducting_body || "N/A"} |\n`;
    text += `| Level | ${ex.exam_level} |\n`;
    text += `| For Degree | ${ex.target_degree || "N/A"} |\n`;
    text += `| Eligible Streams | ${ex.eligible_streams ? ex.eligible_streams.join(", ") : "Any"} |\n`;
    text += `| Eligible Boards | ${ex.eligible_boards ? ex.eligible_boards.join(", ") : "Any"} |\n`;
    text += `| Exam Month | ${ex.approx_exam_month || "N/A"} |\n`;
    text += `| Registration Month | ${ex.approx_registration_month || "N/A"} |\n`;
    text += `| Difficulty | ${ex.difficulty || "N/A"} |\n`;
    text += `| Prep Time | ${ex.prep_time_months ? ex.prep_time_months + " months" : "N/A"} |\n`;
    text += `| Official Website | ${ex.official_website || "N/A"} |\n`;
    if (ex.accepting_colleges && ex.accepting_colleges.length > 0)
      text += `| Accepted By (in our DB) | ${ex.accepting_colleges.join(", ")} |\n`;
    text += `\n`;
    if (ex.description) text += `**Description:** ${ex.description}\n\n`;
  } else {
    // Table view for multiple exams
    text += `| # | Exam | Full Name | Level | For | Streams | Difficulty | Prep Time |\n`;
    text += `|---|------|-----------|-------|-----|---------|------------|----------|\n`;

    result.rows.forEach((ex, i) => {
      const streams = ex.eligible_streams ? ex.eligible_streams.join(", ") : "Any";
      const prep = ex.prep_time_months ? `${ex.prep_time_months}m` : "N/A";
      text += `| ${i + 1} | ${ex.name} | ${ex.full_name || ""} | ${ex.exam_level} | ${ex.target_degree || "N/A"} | ${streams} | ${ex.difficulty || "N/A"} | ${prep} |\n`;
    });
  }

  return text.trim();
}

// =============================================================================
// 10. BOARD GUIDANCE
// =============================================================================

export async function getBoardInfo(boardName?: string): Promise<string> {
  let query: string;
  let params: string[];

  if (boardName) {
    query = `
      SELECT b.*,
             json_agg(json_build_object(
               'stream_code', bs.stream_code,
               'stream_name', bs.stream_name,
               'subjects', bs.subjects,
               'typical_career_paths', bs.typical_career_paths
             )) as streams
      FROM boards b
      LEFT JOIN board_streams bs ON b.id = bs.board_id
      WHERE LOWER(b.name) = LOWER($1) OR LOWER(b.full_name) LIKE LOWER('%' || $1 || '%')
      GROUP BY b.id
    `;
    params = [boardName];
  } else {
    query = `
      SELECT b.*,
             json_agg(json_build_object(
               'stream_code', bs.stream_code,
               'stream_name', bs.stream_name,
               'subjects', bs.subjects,
               'typical_career_paths', bs.typical_career_paths
             )) as streams
      FROM boards b
      LEFT JOIN board_streams bs ON b.id = bs.board_id
      GROUP BY b.id
      ORDER BY b.name
    `;
    params = [];
  }

  const result = await pool.query(query, params);
  if (result.rows.length === 0) return "";

  let text = `## Board Information (from database)\n\n`;

  for (const b of result.rows) {
    text += `### ${b.name} — ${b.full_name || ""}\n\n`;
    text += `- Grading System: ${b.grading_system || "N/A"}\n`;
    if (b.cgpa_to_percentage_formula)
      text += `- CGPA to %: ${b.cgpa_to_percentage_formula}\n`;
    text += `- Recognized Nationally: ${b.recognized_nationally ? "Yes" : "No"}\n`;
    if (b.notes) text += `- Note: ${b.notes}\n`;
    text += `\n`;

    if (b.streams && Array.isArray(b.streams)) {
      text += `**Streams Available:**\n\n`;
      text += `| Stream | Name | Core Subjects | Career Paths |\n`;
      text += `|--------|------|---------------|-------------|\n`;

      for (const s of b.streams) {
        if (!s.stream_code) continue;
        const subjects = s.subjects ? s.subjects.join(", ") : "N/A";
        const careers = s.typical_career_paths
          ? s.typical_career_paths.join(", ")
          : "N/A";
        text += `| ${s.stream_code} | ${s.stream_name || ""} | ${subjects} | ${careers} |\n`;
      }
      text += `\n`;
    }
  }

  return text.trim();
}

// =============================================================================
// 11. CAREER GUIDANCE
// =============================================================================

export async function getCareerPaths(
  stream?: string,
  careerName?: string
): Promise<string> {
  let query: string;
  let params: string[];

  if (careerName) {
    query = `
      SELECT * FROM career_paths
      WHERE LOWER(career_name) LIKE LOWER($1)
      ORDER BY stream, career_name
    `;
    params = [`%${careerName}%`];
  } else if (stream) {
    query = `
      SELECT * FROM career_paths
      WHERE stream = $1 OR stream = 'Any'
      ORDER BY growth_outlook DESC NULLS LAST, career_name
    `;
    params = [stream];
  } else {
    query = `
      SELECT * FROM career_paths
      ORDER BY stream, career_name
    `;
    params = [];
  }

  const result = await pool.query(query, params);
  if (result.rows.length === 0) return "";

  let text = `## Career Guidance (from database)\n\n`;

  if (stream) text += `**Careers for ${stream} stream:**\n\n`;

  text += `| # | Career | Stream | Category | Entry Salary | Mid Salary | Senior Salary | Outlook |\n`;
  text += `|---|--------|--------|----------|-------------|-----------|---------------|--------|\n`;

  result.rows.forEach((cp, i) => {
    text += `| ${i + 1} | ${cp.career_name} | ${cp.stream} | ${cp.career_category || "N/A"} | ${cp.salary_entry || "N/A"} | ${cp.salary_mid || "N/A"} | ${cp.salary_senior || "N/A"} | ${cp.growth_outlook || "N/A"} |\n`;
  });

  text += `\n### Career Details\n\n`;
  for (const cp of result.rows) {
    text += `**${cp.career_name}** (${cp.stream})\n`;
    if (cp.career_description) text += `- ${cp.career_description}\n`;
    text += `- Recommended Courses: ${cp.recommended_courses ? cp.recommended_courses.join(", ") : "N/A"}\n`;
    text += `- Required Skills: ${cp.required_skills ? cp.required_skills.join(", ") : "N/A"}\n`;
    text += `- Recommended Exams: ${cp.recommended_exams ? cp.recommended_exams.join(", ") : "N/A"}\n`;
    text += `- Salary: Entry ${cp.salary_entry || "N/A"} | Mid ${cp.salary_mid || "N/A"} | Senior ${cp.salary_senior || "N/A"}\n`;
    text += `- Growth Outlook: ${cp.growth_outlook || "N/A"}\n`;
    if (cp.notes) text += `- Note: ${cp.notes}\n`;
    text += `\n`;
  }

  return text.trim();
}

// =============================================================================
// 12. MASTER DISPATCHER — Called by the route handler
// =============================================================================
// Takes the detected intent and returns formatted SQL context.
// The route handler doesn't need to know which function to call —
// it just passes the intent and gets back context text.

import type { DetectedIntent } from "./intent";

export async function getStructuredContext(
  intent: DetectedIntent,
  universitySlug: string
): Promise<string> {
  const { type, entities } = intent;

  switch (type) {
    case "fee_inquiry":
      return getCourseFees(universitySlug, entities.course);

    case "eligibility_check":
      return checkEligibility(
        universitySlug,
        entities.stream,
        entities.percentage,
        entities.board,
        entities.course
      );

    case "course_list":
      return getCourseList(universitySlug);

    case "course_detail":
      // Get both fees and eligibility for the specific course
      const [fees, eligibility] = await Promise.all([
        getCourseFees(universitySlug, entities.course),
        checkEligibility(
          universitySlug,
          undefined,
          undefined,
          undefined,
          entities.course
        ),
      ]);
      return [fees, eligibility].filter(Boolean).join("\n\n");

    case "hostel_inquiry":
      return getHostels(universitySlug, entities.hostelType);

    case "transport_inquiry":
      return getTransport(universitySlug);

    case "scholarship_inquiry":
      return getScholarships(universitySlug, entities.percentage);

    case "cost_of_living":
      // Get city from the college's city if not specified
      if (!entities.city) {
        const college = await pool.query(
          "SELECT city FROM colleges WHERE slug = $1",
          [universitySlug]
        );
        entities.city = college.rows[0]?.city;
      }
      return getCostOfLiving(entities.city);

    case "exam_guidance":
      return getExamInfo(entities.exam, entities.stream, universitySlug);

    case "board_guidance":
      return getBoardInfo(entities.board);

    case "career_guidance":
      return getCareerPaths(entities.stream, entities.career);

    case "college_info":
      return getCollegeInfo(universitySlug);

    case "comparison": {
      // For comparisons, gather multiple data sources
      const parts: string[] = [];
      if (entities.course) {
        parts.push(await getCourseFees(universitySlug, entities.course));
      }
      const hostelData = await getHostels(universitySlug);
      if (hostelData) parts.push(hostelData);
      const costData = await getCostOfLiving();
      if (costData) parts.push(costData);
      return parts.filter(Boolean).join("\n\n");
    }

    case "general":
    default:
      // No structured data needed — RAG handles it
      return "";
  }
}
