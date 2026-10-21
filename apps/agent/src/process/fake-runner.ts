import { assertProcessRequest, type ProcessRequest, type ProcessResult, type ProcessRunner } from "./types.js";

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];

  constructor(private readonly handler: (request: ProcessRequest) => ProcessResult | Promise<ProcessResult>) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    assertProcessRequest(request);
    this.calls.push(request);
    return this.handler(request);
  }
}
