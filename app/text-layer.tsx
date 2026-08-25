"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PageGeometry, PageLink } from "../src/pdf/book";
import { cite, type Labels } from "../lib/printed";

/**
 * A selectable text layer laid over a rendered page.
 *
 * The page stays a server-rendered PNG — this adds transparent, positioned
 * copies of every word on top of it, so the page can be selected, copied and
 * clicked without pdf.js ever reaching the browser. It is pdf.js's own
 * `TextLayer`, with the arithmetic moved to `Pages.geometry` and only the two
 * font measurements that genuinely need a browser left here.
 *
 * Everything is positioned in percentages of the page box, so **zoom recomputes
 * nothing**: the same layer is correct at every width the pane can render.
 */
export function TextLayer({
  book,
  page,
  printed,
  width,
  onFollow,
}: {
  book: string;
  page: number;
  /** The book's own page numbers — a link's tooltip says where it goes. */
  printed: Labels;
  /** The rendered width of the page image, in CSS pixels. */
  width: number;
  /** A link inside the book was clicked, with the page it points at. */
  onFollow: (page: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [laid, setLaid] = useState<Laid | null>(null);

  // A unit can run to forty pages and every one carries ~66 spans, so nothing
  // is fetched or built until the page is somewhere near the viewport. Once
  // built it stays: scrolling back over a page you have read should be free.
  useEffect(() => {
    const element = host.current;
    if (!element || near) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setNear(true), {
      rootMargin: "150% 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let live = true;
    fetch(`/api/text?book=${book}&page=${page}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((geometry: PageGeometry) => {
        if (!live) return;
        // Every page in a book is the same shape, so the first one to arrive
        // tells the pane how tall to hold all of them open. See .pageframe.
        document.documentElement.style.setProperty(
          "--page-aspect",
          String(geometry.width / geometry.height),
        );
        setLaid(lay(geometry));
      })
      // A page whose geometry won't load is a page you can't select. That is
      // where it started, so it stays readable rather than throwing.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [book, page, near]);

  return (
    <div
      className="textlayer"
      ref={host}
      style={
        {
          "--scale": laid ? width / laid.width : 1,
          "--min-font-size": laid?.floor ?? 1,
        } as CSSProperties
      }
    >
      {laid?.spans.map((span, i) => (
        <Fragment key={i}>
          {span.str !== "" && (
            <span
              dir={span.dir}
              style={
                {
                  left: `${span.left}%`,
                  top: `${span.top}%`,
                  fontFamily: span.family,
                  "--font-height": `${span.height}px`,
                  "--scale-x": span.scaleX,
                  "--rotate": `${span.rotate}deg`,
                } as CSSProperties
              }
            >
              {span.str}
            </span>
          )}
          {/* pdf.js breaks the line after *any* item carrying hasEOL, text or
              not (build/pdf.mjs:15057). Dropping the ones that also have text
              looks identical on screen and silently glues words together in the
              clipboard — `butmaintaining`. */}
          {span.eol && <br />}
        </Fragment>
      ))}

      {laid?.links.map((link, i) => (
        <a
          key={`link-${i}`}
          className="pagelink"
          href={link.url ?? `#page-${link.page}`}
          target={link.url ? "_blank" : undefined}
          rel={link.url ? "noreferrer" : undefined}
          // These anchors have no text — they are boxes over the page's own
          // words — so without this they reach a keyboard or a screen reader
          // as an unnamed link. Doubles as a tooltip saying where it goes.
          title={
            link.url ?? (link.page === null ? undefined : `goes to ${cite(printed, link.page)}`)
          }
          onClick={(event) => {
            if (link.url || link.page === null) return;
            event.preventDefault();
            onFollow(link.page);
          }}
          style={{
            left: `${link.left * 100}%`,
            top: `${link.top * 100}%`,
            width: `${link.width * 100}%`,
            height: `${link.height * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

/* ── laying the spans out ──────────────────────────────────────── */

interface LaidSpan {
  str: string;
  /** Percent of the page box. */
  left: number;
  top: number;
  /** Font height in PDF units; CSS multiplies it by rendered ÷ page width. */
  height: number;
  scaleX: number;
  rotate: number;
  family: string;
  dir: string;
  eol: boolean;
}

interface Laid {
  width: number;
  /** The smallest font this browser will actually draw — see `floor`. */
  floor: number;
  spans: LaidSpan[];
  links: PageLink[];
}

/**
 * Finish the geometry with the two numbers only a browser knows.
 *
 * The server sends each item's *baseline*, because turning a baseline into a
 * corner needs the ascent of whatever font this browser substituted, and
 * squeezing a span to the width the PDF drew it at needs that font's metrics
 * too. Both come from `measureText`, both are ratios, and both are therefore
 * independent of the scale they are measured at — which is why this runs once
 * per page and never again on zoom.
 */
function lay(geometry: PageGeometry): Laid {
  return {
    width: geometry.width,
    floor: floor(),
    links: geometry.links,
    spans: geometry.spans.map((span) => {
      const ascent = span.height * ascentOf(span.family);
      const left = span.angle === 0 ? span.x : span.x + ascent * Math.sin(span.angle);
      const top = span.angle === 0 ? span.y - ascent : span.y - ascent * Math.cos(span.angle);
      return {
        str: span.str,
        left: (100 * left) / geometry.width,
        top: (100 * top) / geometry.height,
        height: span.height,
        scaleX: span.drawn === null ? 1 : squeeze(span.str, span.height, span.family, span.drawn),
        rotate: span.angle * (180 / Math.PI),
        family: span.family,
        dir: span.dir,
        eol: span.eol,
      };
    }),
  };
}

/** pdf.js measures at the page's real scale; any scale does, since this is a ratio. */
const REFERENCE = 10;

function squeeze(str: string, height: number, family: string, drawn: number): number {
  const context = measuring();
  context.font = `${height * REFERENCE}px ${family}`;
  const { width } = context.measureText(str);
  return width > 0 ? (drawn * REFERENCE) / width : 1;
}

/**
 * How much of a font's line sits above the baseline, per family.
 *
 * `TextLayer.#getAscent`, build/pdf.mjs:15146 — including its 0.8 fallback for
 * browsers that don't report `fontBoundingBoxAscent`. DDIA uses two families,
 * so this measures twice for the whole book.
 */
const ascents = new Map<string, number>();

function ascentOf(family: string): number {
  const cached = ascents.get(family);
  if (cached !== undefined) return cached;

  const context = measuring();
  context.font = `30px ${family}`;
  const metrics = context.measureText("");
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = Math.abs(metrics.fontBoundingBoxDescent);
  const ratio = ascent ? ascent / (ascent + descent) : 0.8;

  ascents.set(family, ratio);
  return ratio;
}

/**
 * The smallest font size this browser will actually draw, in px.
 *
 * A browser with a minimum font size set would silently inflate the smallest
 * spans and pull the layer out of line with the page under it. pdf.js measures
 * the floor and scales the spans back down by it
 * (`TextLayer.#ensureMinFontSizeComputed`, build/pdf.mjs:15132); the CSS in
 * globals.css does the same. Normally 1, in which case none of this does
 * anything. Measured after mount only — it touches the DOM.
 */
let smallest: number | null = null;

function floor(): number {
  if (smallest !== null) return smallest;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;opacity:0;line-height:1;font-size:1px";
  probe.textContent = "X";
  document.body.append(probe);
  smallest = probe.getBoundingClientRect().height || 1;
  probe.remove();
  return smallest;
}

let scratch: CanvasRenderingContext2D | null = null;

function measuring(): CanvasRenderingContext2D {
  scratch ??= document.createElement("canvas").getContext("2d", { alpha: false })!;
  return scratch;
}
