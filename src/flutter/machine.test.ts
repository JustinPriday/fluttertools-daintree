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
  });
});
