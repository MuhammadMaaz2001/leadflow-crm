'use client';
import { api } from './api';
import { useT } from './session';

export interface Member {
  id: string; userId: string; name: string; email: string; jobTitle: string | null; status: 'ACTIVE' | 'DEACTIVATED'; isAssignable: boolean;
  role: { id: string; name: string; key: string | null }; joinedAt: string; lastLoginAt: string | null;
  workload: { openLeads: number; openFollowUps: number; overdueFollowUps: number; openTasks: number; openOpportunities: number };
}
export interface Lookup { id: string; name: string; color: string; isActive: boolean; position: number; usageCount?: number }
export interface Stage { id: string; name: string; color: string; kind: 'OPEN' | 'WON' | 'LOST'; probability: number; position: number; opportunityCount?: number }
export interface Pipeline { id: string; name: string; isDefault: boolean; stages: Stage[] }
export interface CustomField { id: string; key: string; label: string; type: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'BOOLEAN'; options: string[]; required: boolean; isActive: boolean }

export const useMembers = (enabled = true) => useT(['members'], () => api.get<Member[]>('/members'), { enabled, staleTime: 60_000 });
export const useSources = () => useT(['lead-sources'], () => api.get<Lookup[]>('/lead-sources'), { staleTime: 60_000 });
export const usePriorities = () => useT(['lead-priorities'], () => api.get<Lookup[]>('/lead-priorities'), { staleTime: 60_000 });
export const useLostReasons = () => useT(['lost-reasons'], () => api.get<Lookup[]>('/lost-reasons'), { staleTime: 60_000 });
export const useTags = () => useT(['tags'], () => api.get<Lookup[]>('/tags'), { staleTime: 60_000 });
export const usePipelines = () => useT(['pipelines'], () => api.get<Pipeline[]>('/pipelines'), { staleTime: 30_000 });
export const useCustomFields = () => useT(['custom-fields'], () => api.get<CustomField[]>('/custom-fields'), { staleTime: 60_000 });
