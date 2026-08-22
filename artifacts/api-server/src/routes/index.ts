import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reportsRouter);

export default router;
