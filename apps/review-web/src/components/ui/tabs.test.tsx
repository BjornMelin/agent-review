// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

function moduleSiblingFilePath(path: string): string {
  const siblingUrl = new URL(path, import.meta.url);
  if (siblingUrl.protocol === 'file:') {
    return fileURLToPath(siblingUrl);
  }

  return join(process.cwd(), siblingUrl.pathname.replace(/^\/+/, ''));
}

describe('Tabs', () => {
  it('declares a client boundary for Radix event handlers', async () => {
    const tabsFilePath = moduleSiblingFilePath('./tabs.tsx');
    const source = await readFile(tabsFilePath, { encoding: 'utf8' });

    expect(source).toMatch(/^\s*['"]use client['"];?/);
  });

  it('switches panels when a trigger is selected', async () => {
    render(
      <Tabs defaultValue="summary">
        <TabsList aria-label="Review detail tabs">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">Summary panel</TabsContent>
        <TabsContent value="metadata">Metadata panel</TabsContent>
      </Tabs>
    );

    const summaryTab = screen.getByRole('tab', { name: 'Summary' });
    const metadataTab = screen.getByRole('tab', { name: 'Metadata' });

    expect(summaryTab.getAttribute('data-state')).toBe('active');
    expect(metadataTab.getAttribute('data-state')).toBe('inactive');
    expect(screen.getByText('Summary panel')).toBeTruthy();
    expect(screen.queryByText('Metadata panel')).toBeNull();

    await userEvent.click(metadataTab);

    expect(summaryTab.getAttribute('data-state')).toBe('inactive');
    expect(metadataTab.getAttribute('data-state')).toBe('active');
    expect(screen.queryByText('Summary panel')).toBeNull();
    expect(screen.getByText('Metadata panel')).toBeTruthy();
  });
});
