export class ReportCancelledError extends Error {
  constructor() {
    super('Report cancelled');
    this.name = 'ReportCancelledError';
  }
}
