import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";

const execFileAsync = promisify(execFile);

const PROFILE = resolve(import.meta.dirname, "fixtures/log-markers-profile.json.gz");
const CLI = resolve(import.meta.dirname, "../dist/index.js");

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("node", [CLI, ...args], { timeout: 120_000 });
}

describe("--log-markers", () => {
  describe("log-markers-profile", () => {
    it("shows all Log markers across all threads when no filter given", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers"]);

      expect(stdout).toContain("Log markers: 4 total");
      expect(stdout).toContain("[MediaDecoderStateMachine #3]");
      expect(stdout).toContain("[MediaSupervisor #1]");
      expect(stdout).toContain("StateChange DECODING");
      expect(stdout).toContain("StartBuffering reason=NotEnoughData");
      expect(stdout).toContain("Update(Audio) desc:apple coremedia decoder");
      expect(stdout).toContain("Update(Video) desc:blank media data decoder");
    }, 120_000);

    it("excludes non-Log markers", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers"]);

      expect(stdout).not.toContain("DOMEvent");
      expect(stdout).not.toContain("seeking");
    }, 120_000);

    it("shows module labels in output", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers"]);

      expect(stdout).toContain("[D/MediaDecoder]");
      expect(stdout).toContain("[V/MediaFormatReader]");
    }, 120_000);

    it("filters by message content", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers", "blank media"]);

      expect(stdout).toContain("blank media data decoder");
      expect(stdout).not.toContain("StateChange DECODING");
      expect(stdout).not.toContain("Update(Audio)");
    }, 120_000);

    it("filters by module name", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers", "D/MediaDecoder"]);

      expect(stdout).toContain("StateChange DECODING");
      expect(stdout).toContain("StartBuffering reason=NotEnoughData");
      expect(stdout).not.toContain("Update(Audio)");
      expect(stdout).not.toContain("Update(Video)");
    }, 120_000);

    it("filters by thread name", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers", "MediaSupervisor"]);

      expect(stdout).toContain("[MediaSupervisor #1]");
      expect(stdout).toContain("Update(Audio)");
      expect(stdout).toContain("Update(Video)");
      expect(stdout).not.toContain("[MediaDecoderStateMachine #3]");
    }, 120_000);

    it("returns no-match message when filter finds nothing", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers", "xyz_not_found"]);

      expect(stdout).toContain('No Log markers found matching "xyz_not_found"');
    }, 120_000);

    it("outputs markers sorted by time", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers"]);

      const decoding = stdout.indexOf("StateChange DECODING");
      const audio = stdout.indexOf("Update(Audio)");
      const buffering = stdout.indexOf("StartBuffering");
      const video = stdout.indexOf("Update(Video)");

      // t=100 < t=150 < t=200 < t=250
      expect(decoding).toBeLessThan(audio);
      expect(audio).toBeLessThan(buffering);
      expect(buffering).toBeLessThan(video);
    }, 120_000);

    it("shows timestamp for each entry", async () => {
      const { stdout } = await runCli([PROFILE, "--log-markers"]);

      expect(stdout).toMatch(/t=100\.00ms/);
      expect(stdout).toMatch(/t=150\.00ms/);
      expect(stdout).toMatch(/t=200\.00ms/);
      expect(stdout).toMatch(/t=250\.00ms/);
    }, 120_000);
  });
});
