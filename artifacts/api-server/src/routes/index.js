import { Router } from "express";
import authRouter from "./auth.js";
import securityRouter from "./security.js";
import adminRouter from "./admin.js";
import dashboardRouter from "./dashboard.js";
import healthRouter from "./health.js";
import projectsRouter from "./projects.js";
import repairsRouter from "./repairs.js";
import githubRouter from "./github.js";
import observabilityRouter from "./observability.js";
import systemRouter from "./system.js";

const router = Router();

router.use(healthRouter);
router.use(systemRouter);
router.use(authRouter);
router.use(securityRouter);
router.use(adminRouter);
router.use(dashboardRouter);
router.use(projectsRouter);
router.use(repairsRouter);
router.use(githubRouter);
router.use(observabilityRouter);

export default router;
