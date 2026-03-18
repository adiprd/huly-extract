import os
import json
import re
import duckdb
import requests
from dotenv import load_dotenv

load_dotenv()

CONFIG = {
    "motherduck_token": os.getenv("MOTHERDUCK_TOKEN"),
    "motherduck_db":    os.getenv("MOTHERDUCK_DB", "mydb"),
    "ai_endpoint":      os.getenv("AI_ENDPOINT", "https://adiptriya-qwen3-1-7b.hf.space/chat"),
    "min_score":        90,
    "max_retries":      3,
}

def log(msg): print(f"[TRANSFORM] {msg}")

# ── MotherDuck connection ─────────────────────────────────────────────────────

def get_conn():
    token = CONFIG["motherduck_token"]
    db    = CONFIG["motherduck_db"]
    return duckdb.connect(f"md:{db}?motherduck_token={token}")

def setup_clean_tables(conn):
    conn.execute("DROP TABLE IF EXISTS project_tree")
    conn.execute("DROP TABLE IF EXISTS issues_clean")

    conn.execute("""
        CREATE TABLE issues_clean (
            id                  VARCHAR,
            project_id          VARCHAR,
            title_clean         VARCHAR,
            status_normalized   VARCHAR,
            priority_normalized VARCHAR,
            category            VARCHAR,
            summary             VARCHAR,
            tags                VARCHAR,
            complexity          VARCHAR,
            assignee            VARCHAR,
            component           VARCHAR,
            milestone           VARCHAR,
            estimation          BIGINT,
            spent_time          BIGINT,
            remaining_time      BIGINT,
            parent_issue        VARCHAR,
            due_date            BIGINT,
            created_on          BIGINT,
            modified_on         BIGINT,
            sub_issues          INTEGER
        )
    """)

    conn.execute("""
        CREATE TABLE project_tree (
            project_id      VARCHAR,
            root_project    VARCHAR,
            layer           VARCHAR,
            display_name    VARCHAR,
            full_path       VARCHAR,
            confidence      INTEGER
        )
    """)

# ── AI caller ─────────────────────────────────────────────────────────────────

def call_ai(system: str, user: str) -> str:
    full_message = f"[SYSTEM]\n{system}\n\n[USER]\n{user}"
    res = requests.post(
        CONFIG["ai_endpoint"],
        json={"message": full_message},
        timeout=120,
    )
    res.raise_for_status()
    data = res.json()
    if isinstance(data, str):
        return data
    return data.get("response") or data.get("message") or data.get("content") or str(data)

def call_with_confidence(system: str, user: str, label: str) -> dict:
    feedback = ""
    last = {}

    for attempt in range(1, CONFIG["max_retries"] + 1):
        prompt = user
        if feedback:
            prompt += (
                f"\n\nAttempt {attempt}: previous confidence was {last.get('confidence', '?')}% "
                f"(minimum required: {CONFIG['min_score']}%).\n"
                f"Feedback: {feedback}\n"
                "Re-analyze carefully and improve your confidence score."
            )

        raw = call_ai(system, prompt)

        clean = re.sub(r"^```json\s*|^```\s*|```\s*$", "", raw.strip(), flags=re.MULTILINE).strip()
        match = re.search(r"\{.*\}", clean, re.DOTALL)
        if match:
            clean = match.group(0)

        try:
            parsed = json.loads(clean)
            last = parsed
            conf = parsed.get("confidence", 100)
            log(f"  [{label}] attempt {attempt}: confidence={conf}%")
            if conf >= CONFIG["min_score"]:
                return parsed
            feedback = parsed.get("reasoning", "Low confidence, reconsider.")
        except Exception as e:
            log(f"  [{label}] attempt {attempt}: JSON parse failed — {e}")
            log(f"  Raw: {raw[:300]}")
            feedback = "Response was not valid JSON. Return ONLY a raw JSON object, no markdown fences."

    log(f"  [{label}] max retries reached, using last result")
    return last

# ── Issue cleaning ────────────────────────────────────────────────────────────

ISSUE_SYSTEM = """You are a project management data analyst.
Given a raw issue, return ONLY a JSON object with these exact fields:
{
  "confidence": <int 0-100>,
  "title_clean": "<fixed title, correct typos, normalize casing>",
  "status_normalized": "<one of: backlog | todo | in_progress | in_review | done | cancelled>",
  "priority_normalized": "<one of: urgent | high | medium | low | none>",
  "category": "<one of: feature | bug | task | chore | docs | test | other>",
  "summary": "<1-sentence plain English description of what this issue is about>",
  "tags": ["<tag1>", "<tag2>"],
  "complexity": "<one of: low | medium | high>",
  "reasoning": "<brief explanation>"
}
No markdown, no extra text. Return raw JSON only."""

def clean_issue(issue: dict) -> dict:
    label  = issue.get("id", "?")
    user   = f"Issue data:\n{json.dumps(issue, ensure_ascii=False, indent=2)}"
    result = call_with_confidence(ISSUE_SYSTEM, user, label)
    return {
        "id":                  issue["id"],
        "project_id":          issue["project_id"],
        "title_clean":         result.get("title_clean", issue.get("title", "")),
        "status_normalized":   result.get("status_normalized", ""),
        "priority_normalized": result.get("priority_normalized", ""),
        "category":            result.get("category", "other"),
        "summary":             result.get("summary", ""),
        "tags":                json.dumps(result.get("tags", [])),
        "complexity":          result.get("complexity", "medium"),
        "assignee":            issue.get("assignee"),
        "component":           issue.get("component"),
        "milestone":           issue.get("milestone"),
        "estimation":          issue.get("estimation"),
        "spent_time":          issue.get("spent_time"),
        "remaining_time":      issue.get("remaining_time"),
        "parent_issue":        issue.get("parent_issue"),
        "due_date":            issue.get("due_date"),
        "created_on":          issue.get("created_on"),
        "modified_on":         issue.get("modified_on"),
        "sub_issues":          issue.get("sub_issues", 0),
    }

# ── Project restructuring ─────────────────────────────────────────────────────

PROJECT_SYSTEM = """You are a software engineering analyst.
Given a list of projects, detect which ones belong to the same product/system
and how they relate (frontend, backend, design, mobile, infra, etc).

Return ONLY a JSON object:
{
  "confidence": <int 0-100>,
  "reasoning": "<brief explanation>",
  "tree": [
    {
      "project_id": "<original identifier e.g. SKYRO>",
      "root_project": "<detected root product slug e.g. skyroute>",
      "layer": "<fe | be | design | mobile | infra | docs | test | other>",
      "display_name": "<human readable name>",
      "full_path": "<root/layer e.g. skyroute/fe>"
    }
  ]
}

Rules:
- Group projects that clearly belong to the same product (e.g. 'SkyRoute FE' and 'SkyRoute BE' -> root: skyroute)
- A standalone project with no siblings stays as its own root with layer: other
- root_project must be lowercase-slug
- layer must be one of: fe | be | design | mobile | infra | docs | test | other
- No markdown, no extra text. Return raw JSON only."""

def restructure_projects(projects: list) -> list:
    user   = f"Projects:\n{json.dumps(projects, ensure_ascii=False, indent=2)}"
    result = call_with_confidence(PROJECT_SYSTEM, user, "project_tree")
    rows = []
    for item in result.get("tree", []):
        rows.append({
            "project_id":   item.get("project_id", ""),
            "root_project": item.get("root_project", ""),
            "layer":        item.get("layer", "other"),
            "display_name": item.get("display_name", ""),
            "full_path":    item.get("full_path", ""),
            "confidence":   result.get("confidence", 0),
        })
    return rows

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log("Connecting to MotherDuck...")
    conn = get_conn()
    log("Connected ✓")
    setup_clean_tables(conn)

    # 1. Restructure projects
    log("Fetching projects...")
    projects = conn.execute("SELECT * FROM projects").fetchdf().to_dict("records")
    log(f"Found {len(projects)} projects — restructuring with AI...")
    tree_rows = restructure_projects(projects)
    if tree_rows:
        conn.executemany(
            "INSERT INTO project_tree VALUES (?,?,?,?,?,?)",
            [[r["project_id"], r["root_project"], r["layer"],
              r["display_name"], r["full_path"], r["confidence"]]
             for r in tree_rows]
        )
        log(f"Inserted {len(tree_rows)} rows -> project_tree")

    # 2. Clean issues
    log("Fetching issues...")
    issues = conn.execute("SELECT * FROM issues").fetchdf().to_dict("records")
    log(f"Found {len(issues)} issues — cleaning with AI...")
    clean_rows = []
    for i, issue in enumerate(issues):
        log(f"  [{i+1}/{len(issues)}] {issue['id']}")
        clean_rows.append(clean_issue(issue))

    if clean_rows:
        cols = list(clean_rows[0].keys())
        conn.executemany(
            f"INSERT INTO issues_clean VALUES ({','.join(['?']*len(cols))})",
            [[r[c] for c in cols] for r in clean_rows]
        )
        log(f"Inserted {len(clean_rows)} rows -> issues_clean")

    log("────────────────────────────────────────")
    log(f"project_tree : {conn.execute('SELECT COUNT(*) FROM project_tree').fetchone()[0]}")
    log(f"issues_clean : {conn.execute('SELECT COUNT(*) FROM issues_clean').fetchone()[0]}")
    log("Transform finished ✓")
    conn.close()

if __name__ == "__main__":
    main()