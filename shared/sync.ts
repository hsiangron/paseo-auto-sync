import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const syncSessionsRpc = defineRpc({
  name: "sessions.sync",
  input: z.object({}),
  output: z.object({
    status: z.enum(["started", "running"]),
  }),
});
