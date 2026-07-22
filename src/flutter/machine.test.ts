import { describe, expect, it } from "vitest";
import { FlutterMachineProcess } from "./machine.js";

describe("FlutterMachineProcess", () => {
  it("correlates JSON-line requests and forwards machine events", async () => {
    const script = `let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;const ls=b.split(/\\n/);b=ls.pop();for(const l of ls){const m=JSON.parse(l)[0];process.stdout.write(JSON.stringify([{id:m.id,result:{echo:m.method}}])+'\\n');process.stdout.write(JSON.stringify([{event:'test.event',params:{ok:true}}])+'\\n')}})`;
    const machine = new FlutterMachineProcess({ executable: process.execPath, args: ["-e", script] });
    const event = new Promise<string>((resolve) => machine.once("message", (message) => resolve(message.event ?? "")));
    machine.start();
    await expect(machine.request("device.getDevices")).resolves.toEqual({ echo: "device.getDevices" });
    await expect(event).resolves.toBe("test.event");
    await machine.close();
    expect(machine.running).toBe(false);
  });

  it.skipIf(process.platform === "win32")("escalates when a process ignores SIGTERM", async () => {
    const script = `process.on('SIGTERM',()=>{});let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;const ls=b.split(/\\n/);b=ls.pop();for(const l of ls){const m=JSON.parse(l)[0];process.stdout.write(JSON.stringify([{id:m.id,result:true}])+'\\n')}});setInterval(()=>{},1000)`;
    const machine = new FlutterMachineProcess({
      executable: process.execPath,
      args: ["-e", script],
      terminationGraceMs: 25,
    });
    const exit = new Promise<NodeJS.Signals | null>((resolve) => {
      machine.once("exit", (_code, signal) => resolve(signal));
    });
    machine.start();
    await expect(machine.request("ready")).resolves.toBe(true);
    await machine.close();
    await expect(exit).resolves.toBe("SIGKILL");
    expect(machine.running).toBe(false);
  });

  it("returns to a stopped state after spawn failure", async () => {
    const machine = new FlutterMachineProcess({
      executable: "/definitely/missing/flutter-tools-test-executable",
      args: [],
    });
    const error = new Promise<Error>((resolve) => machine.once("processError", resolve));
    machine.start();
    await expect(error).resolves.toBeInstanceOf(Error);
    await machine.close();
    expect(machine.running).toBe(false);
  });
});
