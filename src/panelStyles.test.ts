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

  it("uses a responsive media grid and an overlay media delete control", () => {
    expect(panelStyles).not.toContain("grid-template-columns:minmax(185px");
    expect(panelStyles).toContain(".ft-media{overflow:auto");
    expect(panelStyles).toContain("grid-template-columns:repeat(auto-fill,minmax(220px,1fr))");
    expect(panelStyles).toContain(".ft-shot-delete{position:absolute;top:7px;right:7px");
    expect(panelStyles).toContain(".ft-media-actions{position:absolute;z-index:2;top:7px;left:7px");
    expect(panelStyles).toContain("@container flutter-tools (max-width:480px)");
    expect(panelStyles).toContain(".ft-media{grid-template-columns:minmax(0,1fr);padding:8px}");
  });

  it("keeps the idle recorder compact while preserving active status text", () => {
    expect(panelStyles).toContain(".ft-record-btn{width:29px;min-width:29px");
    expect(panelStyles).toContain(".ft-record-btn.active{width:auto;min-width:72px");
    expect(panelStyles).not.toContain(".ft-record-btn span{display:none}");
  });

  it("keeps launch parameters discoverable and responsive without occupying the default toolbar", () => {
    expect(panelStyles).toContain(".ft-param-chip");
    expect(panelStyles).toContain(".ft-params-dialog");
    expect(panelStyles).toContain(".ft-param-row");
    expect(panelStyles).toContain("max-width:480px");
  });

  it("keeps release launch behind the existing Run control", () => {
    expect(panelStyles).toContain(".ft-run-action{position:relative;display:inline-flex}");
    expect(panelStyles).toContain(".ft-run-popover{position:absolute");
    expect(panelStyles).toContain(".ft-run-option");
    expect(panelStyles).toContain(".ft-mode-badge");
  });

  it("wraps long recovery diagnostics instead of truncating them", () => {
    expect(panelStyles).toContain(".ft-error{min-height:34px;max-height:min(132px,35%)");
    expect(panelStyles).toContain(".ft-error span{min-width:0;flex:1;white-space:normal;overflow-wrap:anywhere");
    expect(panelStyles).not.toContain(".ft-error span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
  });
});
