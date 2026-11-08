import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { cx } from '../lib/cx';
import { STATUS_META } from '../lib/status';
import { useProjects } from '../lib/store';
import { NAV_ITEMS } from './nav-items';
import { IconFolder, IconPage, IconSearch } from './icons';

interface SearchItem {
  key: string;
  group: '页面' | '项目';
  title: string;
  subtitle: string;
  to: string;
}

interface GlobalSearchProps {
  open: boolean;
  onClose(): void;
}

/** 全局搜索（Ctrl/⌘+K）：覆盖主导航页面与全部项目，键盘可完整操作。 */
export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const navigate = useNavigate();
  const { projects } = useProjects();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // 下一帧聚焦，等待 portal 挂载。
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<SearchItem[]>(() => {
    const pageItems: SearchItem[] = NAV_ITEMS.map((item) => ({
      key: `page-${item.to}`,
      group: '页面',
      title: item.label,
      subtitle: item.to === '/' ? '项目卡片与 CRUD' : `路由 ${item.to}`,
      to: item.to,
    }));
    const projectItems: SearchItem[] = projects.map((project) => ({
      key: `project-${project.id}`,
      group: '项目',
      title: project.name,
      subtitle: project.goal || STATUS_META[project.status].label,
      to: `/projects/${project.id}`,
    }));
    const all = [...pageItems, ...projectItems];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((item) => `${item.title} ${item.subtitle}`.toLowerCase().includes(q));
  }, [projects, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const groups: Array<{ label: '页面' | '项目'; entries: Array<{ item: SearchItem; index: number }> }> = [];
  items.forEach((item, index) => {
    let group = groups.find((candidate) => candidate.label === item.group);
    if (!group) {
      group = { label: item.group, entries: [] };
      groups.push(group);
    }
    group.entries.push({ item, index });
  });

  const go = (item: SearchItem) => {
    onClose();
    navigate(item.to);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => Math.min(items.length - 1, value + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[active];
      if (item) go(item);
    }
  };

  return createPortal(
    <div
      className="search-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="search-palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div className="search-input-row">
          <IconSearch />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面、项目…"
            aria-label="搜索页面、项目"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="search-results">
          {items.length === 0 ? (
            <div className="search-empty">没有匹配「{query}」的结果</div>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="search-group">
                <div className="search-group-label">{group.label}</div>
                {group.entries.map(({ item, index }) => (
                  <button
                    key={item.key}
                    type="button"
                    className={cx('search-item', index === active && 'is-active')}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(item)}
                  >
                    {item.group === '页面' ? <IconPage /> : <IconFolder />}
                    <span className="search-item-title">{item.title}</span>
                    <span className="search-item-sub">{item.subtitle}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="search-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 切换
          </span>
          <span>
            <kbd>↵</kbd> 打开
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
