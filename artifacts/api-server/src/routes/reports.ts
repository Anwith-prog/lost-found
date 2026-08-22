import { Router, type IRouter } from "express";
import { desc, eq, ne } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import {
  CreateReportBody,
  FindReportMatchesParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toReport = (row: typeof reportsTable.$inferSelect) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});

router.get("/reports", async (_req, res) => {
  const rows = await db.select().from(reportsTable).orderBy(desc(reportsTable.createdAt));
  res.json(rows.map(toReport));
});

router.post("/reports", async (req, res) => {
  const parsed = CreateReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please complete the required report fields." });
    return;
  }

  const report = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    ...parsed.data,
    contact: parsed.data.contact ?? "",
    image: parsed.data.image ?? null,
  };
  const [created] = await db.insert(reportsTable).values(report).returning();
  res.status(201).json(toReport(created));
});

router.get("/reports/:id/matches", async (req, res) => {
  const parsed = FindReportMatchesParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid report id." });
    return;
  }
  const [source] = await db.select().from(reportsTable).where(eq(reportsTable.id, parsed.data.id));
  if (!source) {
    res.status(404).json({ error: "Report not found." });
    return;
  }

  const candidates = await db.select().from(reportsTable)
    .where(ne(reportsTable.type, source.type))
    .orderBy(desc(reportsTable.createdAt));
  const sourceWords = `${source.description} ${source.category} ${source.location}`.toLowerCase().split(/\W+/).filter(Boolean);
  const matches = candidates.map((candidate) => {
    const candidateText = `${candidate.description} ${candidate.category} ${candidate.location}`.toLowerCase();
    const overlap = sourceWords.filter((word) => word.length > 2 && candidateText.includes(word)).length;
    const confidence = Math.min(96, 24 + overlap * 15 + (candidate.category === source.category ? 24 : 0));
    return {
      report: toReport(candidate),
      confidence,
      explanation: candidate.category === source.category
        ? "Same category with overlapping details makes this worth checking."
        : "Some description and location details overlap with this report.",
    };
  }).filter((match) => match.confidence >= 25).sort((a, b) => b.confidence - a.confidence).slice(0, 5);

  res.json(matches);
});

export default router;