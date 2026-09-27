import { useState } from 'react';

export function Explain({
  caption,
  figure,
  rule,
  figureClassName = '',
  plain = false,
}: {
  caption?: string;
  figure: string;
  rule: string;
  figureClassName?: string;
  plain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="text-left"
      aria-expanded={open}
      onClick={() => {
        setOpen((value) => !value);
      }}
    >
      {caption === undefined ? null : (
        <span className="block text-[13px] font-normal tracking-normal text-[var(--muted)]">
          {caption}
        </span>
      )}
      <span className={plain ? figureClassName : `num ${figureClassName}`}>{figure}</span>
      {open ? (
        <span className="mt-1 block text-[13px] font-normal tracking-normal text-[var(--muted)]">
          {rule}
        </span>
      ) : null}
    </button>
  );
}
