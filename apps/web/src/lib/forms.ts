'use client';
import { useForm, type FieldValues, type Resolver, type DefaultValues, type UseFormSetError, type Path } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ZodType } from 'zod';
import { ApiError } from './api';

/** Zod-validated react-hook-form. The cast keeps form value types simple (inputs are strings from <input>). */
export function useZodForm<T extends FieldValues>(schema: ZodType, defaultValues: DefaultValues<T>) {
  return useForm<T>({ resolver: zodResolver(schema as never) as unknown as Resolver<T>, defaultValues, mode: 'onSubmit', reValidateMode: 'onChange' });
}

/** Maps server-side field errors (400 VALIDATION_ERROR) onto the form; returns a message for non-field errors. */
export function applyServerErrors<T extends FieldValues>(e: unknown, setError: UseFormSetError<T>): string | null {
  if (e instanceof ApiError) {
    if (e.fields) { for (const [k, m] of Object.entries(e.fields)) setError(k as Path<T>, { message: m }); return Object.keys(e.fields).length ? null : e.message; }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}
