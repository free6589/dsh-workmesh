import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as api from './api';
import { demoStore } from './demo-data';
import type { ProjectAction, ProjectInput, ProjectSummary } from './types';

export type DataMode = 'server' | 'demo';

export interface ProjectsContextValue {
  /** server：后端可用；demo：后端不可达，使用内置演示数据。 */
  mode: DataMode;
  loading: boolean;
  error: string | null;
  projects: ProjectSummary[];
  reload(): void;
  createProject(input: ProjectInput): Promise<boolean>;
  updateProject(id: string, input: ProjectInput): Promise<boolean>;
  transitionProject(id: string, action: ProjectAction): Promise<boolean>;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const modeRef = useRef<DataMode>('server');
  const [mode, setMode] = useState<DataMode>('server');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const enterDemo = useCallback(() => {
    modeRef.current = 'demo';
    setMode('demo');
    setProjects(demoStore.list());
  }, []);

  const load = useCallback(async () => {
    if (modeRef.current === 'demo') {
      setProjects(demoStore.list());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listOverview();
      setProjects(list);
      setError(null);
    } catch {
      // 首次加载失败：骨架仍需可独立运行，降级为演示数据。
      enterDemo();
    } finally {
      setLoading(false);
    }
  }, [enterDemo]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  const createProject = useCallback(
    async (input: ProjectInput) => {
      if (modeRef.current === 'demo') {
        demoStore.create(input);
        setProjects(demoStore.list());
        return true;
      }
      try {
        await api.createProject(input);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [load],
  );

  const updateProject = useCallback(
    async (id: string, input: ProjectInput) => {
      if (modeRef.current === 'demo') {
        demoStore.update(id, input);
        setProjects(demoStore.list());
        return true;
      }
      try {
        await api.updateProject(id, input);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [load],
  );

  const transitionProject = useCallback(
    async (id: string, action: ProjectAction) => {
      if (modeRef.current === 'demo') {
        demoStore.transition(id, action);
        setProjects(demoStore.list());
        return true;
      }
      try {
        await api.transitionProject(id, action);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [load],
  );

  const value = useMemo<ProjectsContextValue>(
    () => ({
      mode,
      loading,
      error,
      projects,
      reload,
      createProject,
      updateProject,
      transitionProject,
    }),
    [mode, loading, error, projects, reload, createProject, updateProject, transitionProject],
  );

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjects(): ProjectsContextValue {
  const value = useContext(ProjectsContext);
  if (!value) throw new Error('useProjects 必须在 <ProjectsProvider> 内使用');
  return value;
}
