import { describe, expect, it } from "vitest";
import { panelStyles } from "./panelStyles.js";

describe("Flutter Tools panel layout policy", () => {
  it("keeps fixed controls from starving the console in short panels", () => {
    expect(panelStyles).toContain(".ft-repo-bar,.ft-launch-bar,.ft-session-bar{display:flex;min-width:0;flex:0 0 auto");
    expect(panelStyles).toContain(".ft-main{display:flex;width:100%;min-width:0;min-height:0;flex:1 1 0;height:0");
    expect(panelStyles).toContain(".ft-console-tools{display:flex;min-height:36px;flex:0 0 auto");
    expect(panelStyles).toContain(".ft-toolchain{min-height:25px;flex:0 0 auto");
  });

  it("keeps the console as the zero-based scrolling flex child", () => {
    expect(panelStyles).toContain(".ft-console-wrap{position:relative;display:flex;flex:1 1 0;height:0;min-height:0;min-width:0;flex-direction:column");
    expect(panelStyles).toContain(".ft-console{height:0;min-height:0;flex:1 1 0");
    expect(panelStyles).toContain("overflow-y:scroll");
    expect(panelStyles).toContain("container-type:size");
    expect(panelStyles).toContain("@container flutter-tools (max-height:360px)");
    expect(panelStyles).toContain("@container flutter-tools (max-height:280px)");
    expect(panelStyles).toContain(".ft-repo-bar,.ft-console-tools{display:none}");
  });

  it("uses full-width content and an overlay screenshot delete control", () => {
    expect(panelStyles).not.toContain("grid-template-columns:minmax(185px");
    expect(panelStyles).toContain(".ft-shot{position:relative");
    expect(panelStyles).toContain(".ft-shot-delete{position:absolute;top:7px;right:7px");
  });
});
