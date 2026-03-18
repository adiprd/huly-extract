import dotenv from "dotenv"
dotenv.config()

import fs from "fs"
import path from "path"
import duckdb from "duckdb"
import { connect } from "@hcengineering/api-client"

// ── Huly internal class identifiers ─────────────────────────────────────────
const C = {
  Issue:       "tracker:class:Issue"        as any,
  IssueStatus: "tracker:class:IssueStatus"  as any,
  Component:   "tracker:class:Component"    as any,
  Milestone:   "tracker:class:Milestone"    as any,
  Project:     "tracker:class:Project"      as any,
  ChatMessage: "chunter:class:ChatMessage"  as any,
  TxCUD:       "core:class:TxCUD"           as any,
}

const PRIORITY: Record<number, string> = {
  0: "no-priority", 1: "urgent", 2: "high", 3: "medium", 4: "low"
}

const CONFIG = {
  targetProjects: (process.env.TARGET_PROJECTS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean),
  outputDir: process.env.OUTPUT_DIR!,
  lakeDir:   process.env.DUCKLAKE_DIR!,
  hulyUrl:   process.env.HULY_URL!,
  token:     process.env.HULY_TOKEN!,
  workspace: process.env.HULY_WORKSPACE!,
}

function log(msg: string) { console.log("[PIPELINE]", msg) }

function saveJson(dir: string, name: string, data: unknown) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2))
}

function str(v: any): string | null {
  if (v == null) return null
  if (typeof v === "string") return v
  return v.name ?? v.label ?? v.identifier ?? v._id ?? String(v)
}

// ── DuckDB setup ─────────────────────────────────────────────────────────────

function dbRun(conn: duckdb.Connection, sql: string): Promise<void> {
  return new Promise((res, rej) => conn.run(sql, e => e ? rej(e) : res()))
}

async function setupDB(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  const db   = new duckdb.Database(path.join(dir, "catalog.db"))
  const conn = db.connect()

  for (const t of ["issue_relations","issue_state_history","issue_collaborators",
                    "issue_labels","comments","issues","projects"])
    await dbRun(conn, `DROP TABLE IF EXISTS ${t}`)

  await dbRun(conn, `CREATE TABLE projects(
    id VARCHAR, identifier VARCHAR, name VARCHAR, description VARCHAR)`)

  await dbRun(conn, `CREATE TABLE issues(
    id VARCHAR, project_id VARCHAR, title VARCHAR, status VARCHAR,
    priority VARCHAR, created_by VARCHAR, assignee VARCHAR,
    component VARCHAR, milestone VARCHAR, task_type VARCHAR,
    estimation BIGINT, spent_time BIGINT, remaining_time BIGINT,
    parent_issue VARCHAR, due_date BIGINT,
    created_on BIGINT, modified_on BIGINT, sub_issues INTEGER)`)

  await dbRun(conn, `CREATE TABLE issue_labels(issue_id VARCHAR, label VARCHAR)`)
  await dbRun(conn, `CREATE TABLE issue_collaborators(issue_id VARCHAR, collaborator VARCHAR)`)
  await dbRun(conn, `CREATE TABLE issue_state_history(
    issue_id VARCHAR, state VARCHAR, changed_by VARCHAR, changed_at BIGINT)`)
  await dbRun(conn, `CREATE TABLE issue_relations(
    issue_id VARCHAR, relation_type VARCHAR, related_issue_id VARCHAR)`)
  await dbRun(conn, `CREATE TABLE comments(
    id VARCHAR, issue_id VARCHAR, author VARCHAR, text VARCHAR,
    created_on BIGINT, modified_on BIGINT)`)

  return conn
}

async function insertRows(conn: duckdb.Connection, table: string, rows: any[]) {
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const stmt = conn.prepare(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
  )
  for (const row of rows) {
    const vals = cols.map(c => row[c] ?? null)
    await new Promise<void>((res, rej) =>
      stmt.run(...vals, (e: Error | null) => e ? rej(e) : res()))
  }
  stmt.finalize()
  log(`Inserted ${rows.length} rows -> ${table}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log("Connecting to Huly API...")

  const client = await connect(CONFIG.hulyUrl, {
    token:     CONFIG.token,
    workspace: CONFIG.workspace,
  })
  log("Connected ✓")

  const conn = await setupDB(CONFIG.lakeDir)

  const projectRows:      any[] = []
  const issueRows:        any[] = []
  const labelRows:        any[] = []
  const collaboratorRows: any[] = []
  const stateHistoryRows: any[] = []
  const relationRows:     any[] = []
  const commentRows:      any[] = []

  // ── Lookup tables ────────────────────────────────────────────────────────
  const statuses:   any[] = await client.findAll(C.IssueStatus, {})
  const components: any[] = await client.findAll(C.Component,   {})
  const milestones: any[] = await client.findAll(C.Milestone,   {})

  const statusMap = new Map(statuses.map(s  => [s._id, s.name ?? s.category ?? s._id]))
  const compMap   = new Map(components.map(c => [c._id, c.label ?? c.name ?? c._id]))
  const mileMap   = new Map(milestones.map(m => [m._id, m.label ?? m.name ?? m._id]))

  // ── Projects ─────────────────────────────────────────────────────────────
  const projects: any[] = await client.findAll(C.Project, {})
  log(`Found ${projects.length} projects: ${projects.map((p:any) => p.identifier).join(", ")}`)
  saveJson(CONFIG.outputDir, "_projects_raw.json", projects)

  for (const project of projects) {
    const pid: string = project.identifier ?? project._id

    if (CONFIG.targetProjects.length > 0 &&
        !CONFIG.targetProjects.map(p => p.toLowerCase()).includes(pid.toLowerCase()))
      continue

    log(`Processing: ${pid} — ${project.name}`)
    projectRows.push({
      id: project._id, identifier: pid,
      name: project.name ?? "", description: project.description ?? null,
    })

    // ── Issues ──────────────────────────────────────────────────────────
    const issues: any[] = await client.findAll(
      C.Issue, { space: project._id }, { limit: 10000 }
    )
    log(`  ${issues.length} issues`)
    if (!issues.length) continue
    saveJson(path.join(CONFIG.outputDir, pid), "issues_raw.json", issues)

    // Save first issue as debug reference
    saveJson(path.join(CONFIG.outputDir, pid), "_debug_first_issue.json", issues[0])

    const idToIdent = new Map(issues.map((i: any) => [i._id, i.identifier ?? i._id]))

    for (const issue of issues) {
      const issueId: string = issue.identifier ?? issue._id

      // labels
      for (const lbl of (Array.isArray(issue.labels) ? issue.labels : []))
        labelRows.push({ issue_id: issueId, label: str(lbl) ?? "" })

      // collaborators
      for (const col of (Array.isArray(issue.collaborators) ? issue.collaborators : []))
        collaboratorRows.push({ issue_id: issueId, collaborator: str(col) ?? "" })

      // relations
      for (const rel of (Array.isArray(issue.relations) ? issue.relations : [])) {
        const raw = rel.issue ?? rel.relatedIssue ?? rel.target ?? ""
        const relId = typeof raw === "string" ? (idToIdent.get(raw) ?? raw) : str(raw) ?? ""
        relationRows.push({
          issue_id: issueId,
          relation_type: rel.type ?? rel.relation ?? "related",
          related_issue_id: relId,
        })
      }

      const parentId = issue.attachedTo && issue.attachedTo !== project._id
        ? (idToIdent.get(issue.attachedTo) ?? issue.attachedTo)
        : null

      issueRows.push({
        id:             issueId,
        project_id:     pid,
        title:          issue.title ?? "",
        status:         statusMap.get(issue.status) ?? issue.status ?? "",
        priority:       PRIORITY[issue.priority] ?? String(issue.priority ?? ""),
        created_by:     str(issue.createdBy ?? issue.creator),
        assignee:       str(issue.assignee),
        component:      issue.component ? (compMap.get(issue.component) ?? issue.component) : null,
        milestone:      issue.milestone ? (mileMap.get(issue.milestone) ?? issue.milestone) : null,
        task_type:      str(issue.kind ?? issue.taskType ?? issue.type),
        estimation:     issue.estimation ?? null,
        spent_time:     issue.reportedTime ?? issue.spentTime ?? null,
        remaining_time: issue.remainingTime ?? null,
        parent_issue:   parentId,
        due_date:       issue.dueDate ?? null,
        created_on:     issue.createdOn ?? null,
        modified_on:    issue.modifiedOn ?? null,
        sub_issues:     typeof issue.subIssues === "number" ? issue.subIssues : 0,
      })
    }

    // ── State history via TX log ─────────────────────────────────────────
    try {
      const txs: any[] = await client.findAll(
        C.TxCUD,
        { objectClass: C.Issue, objectSpace: project._id } as any,
        { limit: 100000 }
      )
      const statusTxs = txs.filter((tx: any) => tx.operations?.status != null)
      log(`  ${statusTxs.length} status-change transactions`)
      for (const tx of statusTxs) {
        const ident = idToIdent.get(tx.objectId) ?? tx.objectId
        stateHistoryRows.push({
          issue_id:   ident,
          state:      statusMap.get(tx.operations.status) ?? tx.operations.status,
          changed_by: str(tx.createdBy ?? tx.modifiedBy),
          changed_at: tx.modifiedOn ?? tx.createdOn ?? null,
        })
      }
    } catch (e) {
      log(`  Warning: TX history unavailable — ${(e as Error).message}`)
    }

    // ── Comments ─────────────────────────────────────────────────────────
    try {
      const comments: any[] = await client.findAll(
        C.ChatMessage,
        { attachedToClass: C.Issue, space: project._id } as any,
        { limit: 100000 }
      )
      log(`  ${comments.length} comments`)
      if (comments.length) {
        saveJson(path.join(CONFIG.outputDir, pid), "comments_raw.json", comments)
        for (const c of comments) {
          commentRows.push({
            id:          c._id,
            issue_id:    idToIdent.get(c.attachedTo) ?? c.attachedTo,
            author:      str(c.createdBy ?? c.modifiedBy),
            text:        c.message ?? c.text ?? c.content ?? "",
            created_on:  c.createdOn ?? null,
            modified_on: c.modifiedOn ?? null,
          })
        }
      }
    } catch (e) {
      log(`  Warning: comments unavailable — ${(e as Error).message}`)
    }

    log(`  Done: ${pid}`)
  }

  // ── Insert ────────────────────────────────────────────────────────────────
  await insertRows(conn, "projects",            projectRows)
  await insertRows(conn, "issues",              issueRows)
  await insertRows(conn, "issue_labels",        labelRows)
  await insertRows(conn, "issue_collaborators", collaboratorRows)
  await insertRows(conn, "issue_state_history", stateHistoryRows)
  await insertRows(conn, "issue_relations",     relationRows)
  await insertRows(conn, "comments",            commentRows)

  log("────────────────────────────────────────")
  log(`Projects      : ${projectRows.length}`)
  log(`Issues        : ${issueRows.length}`)
  log(`Labels        : ${labelRows.length}`)
  log(`Collaborators : ${collaboratorRows.length}`)
  log(`State history : ${stateHistoryRows.length}`)
  log(`Relations     : ${relationRows.length}`)
  log(`Comments      : ${commentRows.length}`)
  log("Pipeline finished ✓")

  await client.close()
}

main().catch(err => {
  console.error("[PIPELINE] Fatal:", err)
  process.exit(1)
})