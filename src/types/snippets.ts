export interface SnippetVariable {
  name: string;
  label: string | null;
  default_value: string | null;
  placeholder: string | null;
  options: string[] | null;
  required: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description: string | null;
  folder_id: string | null;
  tags: string | null;
  variables: string | null; // JSON string of SnippetVariable[]
  is_dangerous: boolean;
  use_count: number;
  last_used_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SnippetFolder {
  id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  icon: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SnippetSearchResult {
  snippet: Snippet;
  rank: number;
}
