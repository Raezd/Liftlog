import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { useEffect, useMemo, useRef } from "react";

// Only the pieces we use, to keep the download small. Adapted from Foodlog's chart component.
echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

/** The current theme's colors, so charts match light and dark. */
export function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ink: v("--ink"), muted: v("--muted"), line: v("--line"), surface: v("--surface"), sunken: v("--sunken"),
    accent: v("--accent"), accentText: v("--accent-text"), strong: v("--accent-strong"), over: v("--over"), chart2: v("--chart-2"),
    font: v("--font-sans") || "sans-serif",
  };
}

/** A date x axis with "Sep 17" labels, about three across, for trend charts. Points sit on noon UTC of their date. */
export function dateAxis(p: ReturnType<typeof palette>) {
  return {
    type: "time", splitNumber: 3, axisLine: { lineStyle: { color: p.line } }, splitLine: { show: false },
    axisLabel: { color: p.muted, hideOverlap: true, formatter: (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) },
  };
}

/** ECharts sizes text in px: scale every font size with the phone's text size. */
function scaled(option: EChartsCoreOption, s: number, font: string): EChartsCoreOption {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === "fontSize" && typeof x === "number" ? x * s : k === "data" ? x : walk(x);
    return out;
  };
  const o = walk(option) as Record<string, unknown>;
  const ts = (o.textStyle ?? {}) as Record<string, unknown>;
  o.textStyle = { fontFamily: font, ...ts, fontSize: (ts.fontSize as number | undefined) ?? 13 * s };
  const tip = o.tooltip as Record<string, unknown> | undefined;
  if (tip) o.tooltip = { ...tip, textStyle: { fontFamily: font, fontSize: 15 * s, ...(tip.textStyle as object | undefined) } };
  return o;
}

/** A chart, with `label` read out in place of the picture. */
export default function EChart({ option, height = 240, label }: { option: EChartsCoreOption; height?: number; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    chart.current = echarts.init(el.current!, undefined, { renderer: "canvas" });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); chart.current?.dispose(); };
  }, []);

  const final = useMemo(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return scaled(option, rem / 16, palette().font);
  }, [option]);
  useEffect(() => { chart.current?.setOption(final, true); }, [final]);

  return <div ref={el} style={{ height }} role="img" aria-label={label} />;
}
