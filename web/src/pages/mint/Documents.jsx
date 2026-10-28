// eBL, invoice and insurance upload for the selected case. Files go to the agent's ingest pipeline
// (actual bytes, base64); each job's steps, extracted fields with their source lines, compliance
// screening and findings are listed, and refresh live from the case's activity stream.
// A public sample is never written: uploads, jobs and the stream use this browser's own working copy of it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, useLang } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { agentRequest } from '../../lib/agent-api.js';
import { openWorkspaceCase, refreshWorkspaceCases } from '../../state/controller.js';
import { fileDocument, MAX_BATCH_BYTES, MAX_FILES } from '../../lib/documents.js';
import { Badge, Button, Card, CardHead, Disclosure } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { DecisionButton } from '../../features/evidence/References.jsx';
import { Compliance } from './Compliance.jsx';

const JOB_TONE = { DONE: 'ok', RUNNING: 'info', QUEUED: 'muted', FAILED: 'crit', INTERRUPTED: 'warn' };
// Intake refusals with their own sentence; anything else keeps the server's message.
const UPLOAD_ERRORS = new Set(['upload_quota_exceeded', 'upload_batch_too_large', 'intake_storage_full', 'operations_not_ready', 'duplicate_asset_documents',
  'upload_job_quota_exceeded', 'intake_jobs_full']);
// A finished upload that produced a case: that case can be priced on this page instead of the sample.
const opened = (job) => job.status === 'DONE' && ['OPEN', 'OPEN_WITH_WARNING'].includes(job.result_action);
const uploadError = (failure) => UPLOAD_ERRORS.has(failure?.code) ? t(`ebld_error_${failure.code}`) : failure.message;

export function Documents() {
  useLang();
  const sourceCaseId = useApp((s) => s.caseId);
  // Until the copy is resolved nothing is listed or uploaded, so a sample's public jobs never stand in for the copy's.
  const caseId = useApp((s) => s.workspaceCaseId);
  const generation = useApp((s) => s.modeGeneration);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const reviewId = useRef(null);
  const version = useRef(0);
  const announced = useRef(new Set());

  const refresh = useCallback(async (forCase, requestVersion) => {
    try {
      const data = await agentRequest(`/api/agent/jobs?case_id=${encodeURIComponent(forCase)}&limit=8`);
      if (requestVersion !== version.current) return;
      setJobs(data.jobs ?? []);
      // The case a finished upload produced belongs in the case selector ("My working cases"): ask once per such job.
      const fresh = (data.jobs ?? []).filter((job) => opened(job) && !announced.current.has(job.job_id));
      if (fresh.length) {
        for (const job of fresh) announced.current.add(job.job_id);
        refreshWorkspaceCases();
      }
    } catch (failure) {
      if (requestVersion === version.current) setError(failure.message);
    }
  }, []);

  useEffect(() => {
    const requestVersion = ++version.current;
    setJobs([]); setError(''); reviewId.current = null;
    if (!caseId) return undefined;
    refresh(caseId, requestVersion);
    if (typeof EventSource === 'undefined') return undefined;
    const stream = new EventSource(`/api/agent/activity/stream?case_id=${encodeURIComponent(caseId)}`);
    stream.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'activity' && ['PIPELINE_STEP', 'INGEST_STARTED', 'INGEST_FINISHED'].includes(data.action)) refresh(caseId, requestVersion);
    };
    return () => stream.close();
  }, [caseId, generation, refresh]);

  const upload = async (files) => {
    if (busy || !files?.length) return;
    if (files.length > MAX_FILES) { setError(t('ebld_too_many')); return; }
    if (Array.from(files).reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES) { setError(t('ebld_batch_too_large', { mb: MAX_BATCH_BYTES / 1_048_576 })); return; }
    if (!caseId) return;
    const requestVersion = version.current, forCase = caseId, reviewing = reviewId.current;
    reviewId.current = null;
    setBusy(true); setError('');
    try {
      const documents = await Promise.all(Array.from(files).map((file) => fileDocument(file)));
      const path = reviewing ? `/api/agent/jobs/${encodeURIComponent(reviewing)}/review` : '/api/agent/ingest';
      const data = await agentRequest(path, { method: 'POST', body: reviewing ? { documents, note: 'Corrected documents submitted for deterministic re-evaluation.' } : { case_id: forCase, documents } });
      if (requestVersion !== version.current) return;
      setJobs((current) => [data.job, ...current.filter((job) => job.job_id !== data.job.job_id)]);
      await refresh(forCase, requestVersion);
    } catch (failure) {
      if (requestVersion === version.current) setError(uploadError(failure));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Card className="documents" aria-labelledby="ebl-docs-h">
      <CardHead id="ebl-docs-h" title={t('ebl_upload_h')} level={3} />
      <div
        id="ebl-upload-zone"
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); reviewId.current = null; upload(event.dataTransfer.files); }}
      >
        <Icon name="upload" size={22} />
        <p>{t('ebl_upload_drop')}</p>
        <p className="muted small">
          {t('ebl_upload_or')}{' '}
          <button id="ebl-browse-btn" type="button" className="link-btn" disabled={busy || !caseId} onClick={() => { reviewId.current = null; input.current?.click(); }}>{t('ebl_upload_browse')}</button>{' '}
          {t('ebl_upload_device')}
        </p>
        <p className="muted small">{t('ebl_upload_types')}</p>
        {caseId && caseId !== sourceCaseId ? <p className="muted small">{t('ebld_workspace_copy', { id: caseId, source: sourceCaseId })}</p> : null}
        <input ref={input} id="ebl-file-input" type="file" accept=".md,.txt,.pdf,.png,.jpg,.jpeg" multiple hidden onChange={(event) => upload(event.target.files)} />
      </div>
      <div id="ebl-upload-status" className="jobs" aria-live="polite">
        {error ? <p className="cp-warning">{error}</p> : null}
        {busy ? <p role="status" className="muted">{t('ebld_uploading')}</p> : null}
        {jobs.map((job) => (
          <section key={job.job_id} className="job">
            <header className="job-head">
              <strong>{t('ebld_job')}</strong>
              <Badge tone={JOB_TONE[job.status] ?? 'muted'}>{t(`ebld_status_${job.status}`)}</Badge>
              {job.result_action ? <span className="muted small">{t(`ebld_action_${job.result_action}`)}</span> : null}
            </header>
            {job.steps?.length ? (
              <ol className="job-steps">
                {job.steps.map((step) => (
                  <li key={step.step} className={`job-step is-${String(step.status).toLowerCase()}`}>
                    <span>{t(`ebld_step_${step.step}`)}</span><span className="muted small">{t(`ebld_step_status_${step.status}`)}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {job.compliance ? <Compliance report={job.compliance} /> : null}
            {(job.extraction ?? []).map((document) => {
              const extractor = document.source?.extractor;
              const sourceLabel = t(extractor === 'pdf-text' ? 'ebld_source_pdf' : extractor === 'llm-vision' ? 'ebld_source_vision' : 'ebld_source_text');
              return (
                <Disclosure key={document.source?.filename ?? document.document_type}
                  summary={`${document.source?.filename ?? document.document_type} · ${sourceLabel} · ${t('ebld_confidence')}: ${Math.round(document.confidence * 100)}%`}>
                  {extractor === 'llm-vision' ? <p className="cp-warning">{t('ebld_vision_review_hint')}</p> : null}
                  {document.source?.total_pages ? <p>{`${t('ebld_pages')}: ${document.source.total_pages}`}</p> : null}
                  {document.missing_fields?.length ? <p className="cp-warning">{`${t('ebld_missing_fields')}: ${document.missing_fields.map((name) => t(`ebld_field_${name}`)).join(', ')}`}</p> : null}
                  <dl className="field-list">
                    {Object.entries(document.fields).map(([name, value]) => {
                      const source = document.provenance[name];
                      const location = source?.page ? `${t('ebld_page')}: ${source.page} · ` : '';
                      return (
                        <div key={name}>
                          <dt>{t(`ebld_field_${name}`)}</dt>
                          <dd>{String(value)} <span className="muted small">{`(${location}${t('ebld_line')}: ${source?.line ?? '—'} · ${source?.method ?? '—'})`}</span></dd>
                        </div>
                      );
                    })}
                  </dl>
                </Disclosure>
              );
            })}
            {(job.findings ?? []).map((finding, index) => {
              const key = `ebld_reason_${finding.kind?.startsWith('COMPLIANCE_') ? finding.kind : finding.code ?? finding.kind}`, translated = t(key);
              return <p key={index} className={finding.severity === 'info' ? 'muted' : 'cp-warning'}>{translated === key ? finding.detail : translated}</p>;
            })}
            {(job.decision_ids ?? []).map((id) => <DecisionButton key={id} id={id} />)}
            {opened(job) ? (job.case_id === sourceCaseId
              ? <p className="muted small">{t('ebld_using_case')}</p>
              : <Button variant="primary" size="sm" disabled={busy} onClick={() => openWorkspaceCase(job.case_id)}>{t('ebld_use_case')}</Button>) : null}
            {job.error ? <p className="cp-warning">{job.error.message}</p> : null}
            {job.review_required ? (
              <div className="job-review">
                <p>{t('ebld_review_hint')}</p>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => { reviewId.current = job.job_id; input.current?.click(); }}>{t('ebld_review_upload')}</Button>
              </div>
            ) : null}
          </section>
        ))}
        {!jobs.length && !busy && !error ? <p className="muted small">{t('ebld_no_jobs')}</p> : null}
      </div>
    </Card>
  );
}
