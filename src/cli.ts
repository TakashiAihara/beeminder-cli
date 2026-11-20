#!/usr/bin/env bun
import { Command, CommanderError } from "commander";

import {
  createDatapoint,
  deleteDatapoint,
  getGoal,
  getUser,
  listDatapoints,
  listGoals,
} from "./generated/index.ts";
import type { DatapointInput } from "./generated/model/index.ts";
import { fail, reportError } from "./errors.ts";

type UserOpts = { user: string };
type AddOpts = UserOpts & { comment?: string; requestid?: string; daystamp?: string };

const respond = async (p: Promise<{ data: unknown }>): Promise<void> => {
  try {
    process.stdout.write(`${JSON.stringify((await p).data, null, 2)}\n`);
  } catch (err) {
    reportError(err);
  }
};

const program = new Command();

program.name("beeminder").description("CLI for the Beeminder API").exitOverride();

const withUser = (cmd: Command): Command =>
  cmd.option("--user <username>", "Beeminder username", "me");

withUser(program.command("user").description("Show the user")).action((opts: UserOpts) =>
  respond(getUser(opts.user)),
);

withUser(program.command("goals").description("List goals")).action((opts: UserOpts) =>
  respond(listGoals(opts.user)),
);

withUser(program.command("goal").description("Show one goal").argument("<slug>")).action(
  (slug: string, opts: UserOpts) => respond(getGoal(opts.user, slug)),
);

withUser(
  program.command("datapoints").description("List datapoints of a goal").argument("<slug>"),
).action((slug: string, opts: UserOpts) => respond(listDatapoints(opts.user, slug)));

withUser(
  program
    .command("add")
    .description("Add a datapoint")
    .argument("<slug>")
    .argument("<value>")
    .option("--comment <text>", "datapoint comment")
    .option("--requestid <id>", "idempotency key")
    .option("--daystamp <YYYYMMDD>", "date of the datapoint"),
).action(async (slug: string, raw: string, opts: AddOpts) => {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) {
    fail(`<value> must be a finite number, got ${JSON.stringify(raw)}`, 3);
  }
  const input: DatapointInput = { value };
  if (opts.comment !== undefined) input.comment = opts.comment;
  if (opts.requestid !== undefined) input.requestid = opts.requestid;
  if (opts.daystamp !== undefined) input.daystamp = opts.daystamp;
  await respond(createDatapoint(opts.user, slug, input));
});

withUser(
  program.command("delete").description("Delete a datapoint").argument("<slug>").argument("<id>"),
).action((slug: string, id: string, opts: UserOpts) =>
  respond(deleteDatapoint(opts.user, slug, id)),
);

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) process.exit(err.exitCode === 0 ? 0 : 3);
  reportError(err);
}
