import { useCallback, useRef, useState, type ReactNode } from 'react';

interface DialogState {
  title: string;
  message?: ReactNode;
  input?: string;
  confirmLabel: string;
  danger?: boolean;
  extra?: Array<{ label: string; value: string }>;
  resolve: (v: string | null) => void;
}

/** Promise-basierte Dialoge als Ersatz für window.prompt/confirm */
export function useDialog() {
  const [state, setState] = useState<DialogState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = useCallback(
    (s: Omit<DialogState, 'resolve'>) => new Promise<string | null>((resolve) => setState({ ...s, resolve })),
    [],
  );
  const prompt = useCallback(
    (title: string, initial = '', confirmLabel = 'OK') => open({ title, input: initial, confirmLabel }),
    [open],
  );
  const confirm = useCallback(
    async (title: string, message?: ReactNode, confirmLabel = 'Löschen') =>
      (await open({ title, message, confirmLabel, danger: true })) !== null,
    [open],
  );
  const choose = useCallback(
    (title: string, message: ReactNode, options: Array<{ label: string; value: string }>) =>
      open({ title, message, confirmLabel: '', extra: options }),
    [open],
  );

  const close = (v: string | null) => {
    state?.resolve(v);
    setState(null);
  };

  const element = state && (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <form
        className="card modal"
        onSubmit={(e) => {
          e.preventDefault();
          close(state.input !== undefined ? (inputRef.current?.value ?? '') : 'ok');
        }}
        onKeyDown={(e) => e.key === 'Escape' && close(null)}
      >
        <h3>{state.title}</h3>
        {state.message && <div className="modal-message">{state.message}</div>}
        {state.input !== undefined && (
          <input
            ref={inputRef}
            defaultValue={state.input}
            autoFocus
            onFocus={(e) => {
              const v = e.target.value;
              const dot = v.lastIndexOf('.');
              e.target.setSelectionRange(v.lastIndexOf('/') + 1, dot > 0 ? dot : v.length);
            }}
          />
        )}
        <div className="modal-actions">
          <button type="button" onClick={() => close(null)}>
            Abbrechen
          </button>
          {state.extra?.map((o) => (
            <button type="button" key={o.value} onClick={() => close(o.value)}>
              {o.label}
            </button>
          ))}
          {state.confirmLabel && (
            <button className={state.danger ? 'danger' : 'primary'} autoFocus={state.input === undefined}>
              {state.confirmLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  );

  return { prompt, confirm, choose, element };
}
