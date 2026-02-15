export type RetrievalQuery = {
  queryText: string;
  queryTokens: string[];
  turnsUsed: number;
};

export type RetrievalCandidate = {
  symbolId: string;
  lexicalScore: number;
  vectorScore: number;
  recencyScore: number;
  fusedScore: number;
};

export interface RetrievalPlanner {
  buildQuery(messages: Array<{ role: string; content: string }>): RetrievalQuery;
  selectCandidates(
    threadId: string,
    query: RetrievalQuery,
  ): Promise<RetrievalCandidate[]>;
  rerank(candidates: RetrievalCandidate[]): RetrievalCandidate[];
  confidenceGate(candidates: RetrievalCandidate[]): {
    focused: RetrievalCandidate[];
    recall: RetrievalCandidate[];
    rejected: RetrievalCandidate[];
  };
}
