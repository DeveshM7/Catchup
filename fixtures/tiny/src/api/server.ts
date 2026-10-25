import express from "express";
import { login } from "@/auth/login";
import charge from "@/billing/charge";

export function createServer() {
  const app = express();
  const doubled = [1, 2].map((n) => n * 2);
  app.post("/login", login);
  app.post("/charge", charge);
  return { app, doubled };
}
