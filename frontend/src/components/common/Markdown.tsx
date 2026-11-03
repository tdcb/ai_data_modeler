import React from 'react';

const inline = (text: string, key: string): React.ReactNode[] => {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**'))
      return (
        <strong key={`${key}-${i}`} className="text-white font-semibold">
          {p.slice(2, -2)}
        </strong>
      );
    if (p.startsWith('`') && p.endsWith('`'))
      return (
        <code key={`${key}-${i}`} className="px-1 rounded bg-slate-800 text-sky-300 font-mono text-[0.92em]">
          {p.slice(1, -1)}
        </code>
      );
    return <React.Fragment key={`${key}-${i}`}>{p}</React.Fragment>;
  });
};

/** Minimal, dependency-free markdown renderer for AI replies (headings, lists, bold, code, fences). */
export const Markdown: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const out: React.ReactNode[] = [];
  const lines = (text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(
        <pre key={`pre-${i}`} className="my-1.5 p-2 rounded bg-slate-950 border border-slate-800 text-[11px] font-mono overflow-x-auto text-emerald-200">
          {buf.join('\n')}
        </pre>
      );
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(
        <div key={`h-${i}`} className={`font-semibold text-white mt-2 mb-1 ${h[1].length <= 2 ? 'text-sm' : 'text-xs'}`}>
          {inline(h[2], `h${i}`)}
        </div>
      );
    } else if (/^\s*([-*]|\d+\.)\s+/.test(ln)) {
      const depth = (ln.match(/^\s*/)?.[0].length || 0) >= 2 ? 'ml-4' : 'ml-1';
      out.push(
        <div key={`li-${i}`} className={`${depth} flex gap-1.5`}>
          <span className="text-slate-500">•</span>
          <span>{inline(ln.replace(/^\s*([-*]|\d+\.)\s+/, ''), `li${i}`)}</span>
        </div>
      );
    } else if (ln.trim() === '') {
      out.push(<div key={`sp-${i}`} className="h-1.5" />);
    } else {
      out.push(<div key={`p-${i}`}>{inline(ln, `p${i}`)}</div>);
    }
    i++;
  }
  return <div className={className}>{out}</div>;
};
