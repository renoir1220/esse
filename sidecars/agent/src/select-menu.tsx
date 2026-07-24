import { CaretDown, Check } from '@phosphor-icons/react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type SelectMenuOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export function nextEnabledOptionIndex(
  options: SelectMenuOption[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (!options.length) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (currentIndex + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function edgeEnabledOptionIndex(options: SelectMenuOption[], edge: 'first' | 'last'): number {
  const start = edge === 'first' ? -1 : 0;
  return nextEnabledOptionIndex(options, start, edge === 'first' ? 1 : -1);
}

export function SelectMenu(props: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  leading?: ReactNode;
  className?: string;
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestedFocusIndex = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
  const selectedIndex = props.options.findIndex((option) => option.value === props.value);
  const selected = selectedIndex >= 0 ? props.options[selectedIndex] : undefined;

  const openMenu = (index: number) => {
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (triggerRect) {
      const edgeOffset = 8;
      const align = props.align || 'start';
      const position: CSSProperties = {
        minWidth: Math.max(180, triggerRect.width),
        maxWidth: Math.max(
          180,
          align === 'end'
            ? triggerRect.right - edgeOffset
            : window.innerWidth - Math.max(edgeOffset, triggerRect.left) - edgeOffset,
        ),
      };
      if ((props.placement || 'bottom') === 'top') {
        position.bottom = window.innerHeight - triggerRect.top + 6;
      } else {
        position.top = triggerRect.bottom + 6;
      }
      if (align === 'end') {
        position.right = Math.max(edgeOffset, window.innerWidth - triggerRect.right);
      } else {
        position.left = Math.max(edgeOffset, triggerRect.left);
      }
      setMenuPosition(position);
    }
    requestedFocusIndex.current = index;
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const focusIndex = requestedFocusIndex.current ?? (
      selectedIndex >= 0
        ? selectedIndex
        : edgeEnabledOptionIndex(props.options, 'first')
    );
    requestedFocusIndex.current = undefined;
    const frame = window.requestAnimationFrame(() => optionRefs.current[focusIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    const onViewportChange = () => closeMenu();
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const fallback = direction === 1 ? -1 : 0;
    openMenu(nextEnabledOptionIndex(props.options, selectedIndex >= 0 ? selectedIndex - direction : fallback, direction));
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    let nextIndex = -1;
    if (event.key === 'ArrowDown') nextIndex = nextEnabledOptionIndex(props.options, index, 1);
    if (event.key === 'ArrowUp') nextIndex = nextEnabledOptionIndex(props.options, index, -1);
    if (event.key === 'Home') nextIndex = edgeEnabledOptionIndex(props.options, 'first');
    if (event.key === 'End') nextIndex = edgeEnabledOptionIndex(props.options, 'last');
    if (nextIndex < 0) return;
    event.preventDefault();
    optionRefs.current[nextIndex]?.focus();
  };

  return <div
    ref={rootRef}
    className={`select-menu ${open ? 'is-open' : ''} ${props.className || ''}`}
    data-placement={props.placement || 'bottom'}
    data-align={props.align || 'start'}
  >
    <button
      ref={triggerRef}
      id={`${id}-trigger`}
      type="button"
      className="select-menu-trigger"
      aria-label={props.ariaLabel}
      aria-haspopup="listbox"
      aria-controls={`${id}-listbox`}
      aria-expanded={open}
      disabled={props.disabled}
      onKeyDown={onTriggerKeyDown}
      onClick={() => {
        if (open) {
          closeMenu();
          return;
        }
        openMenu(selectedIndex >= 0 ? selectedIndex : edgeEnabledOptionIndex(props.options, 'first'));
      }}
    >
      {props.leading ? <span className="select-menu-leading" aria-hidden="true">{props.leading}</span> : null}
      <span className={`select-menu-value ${selected ? '' : 'is-placeholder'}`}>{selected?.label || props.placeholder || '请选择'}</span>
      <CaretDown className="select-menu-caret" size={12} aria-hidden="true" />
    </button>
    {open ? createPortal(<div
      ref={menuRef}
      id={`${id}-listbox`}
      className="select-menu-list"
      role="listbox"
      aria-labelledby={`${id}-trigger`}
      data-placement={props.placement || 'bottom'}
      style={menuPosition}
    >
      {props.options.map((option, index) => <button
        ref={(element) => { optionRefs.current[index] = element; }}
        key={option.value}
        type="button"
        className={`select-menu-option ${option.value === props.value ? 'is-selected' : ''}`}
        role="option"
        aria-selected={option.value === props.value}
        disabled={option.disabled}
        tabIndex={-1}
        onKeyDown={(event) => onOptionKeyDown(event, index)}
        onClick={() => {
          props.onChange(option.value);
          closeMenu(true);
        }}
      >
        <span className="select-menu-check" aria-hidden="true">{option.value === props.value ? <Check size={13} weight="bold" /> : null}</span>
        <span className="select-menu-option-copy"><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
      </button>)}
    </div>, document.body) : null}
  </div>;
}
