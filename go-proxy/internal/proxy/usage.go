package proxy

import "net/http"

// ReportOutcome is a normalized request result for report ingestion.
type ReportOutcome struct {
	Outcome           ForwardOutcome
	UpstreamStatus    int
	Error             *ForwardError
	StreamInterrupted bool
}

// NormalizeOutcome maps forwarder transport results to report-safe outcome fields.
func NormalizeOutcome(resp ForwardResponse, transportErr error) ReportOutcome {
	outcome := resp.Outcome
	if outcome == "" {
		outcome = OutcomeOK
	}

	if transportErr != nil || resp.StatusCode >= http.StatusBadRequest {
		outcome = OutcomeError
	}

	normalizedErr := resp.Error
	if normalizedErr == nil && transportErr != nil {
		phase := "transport"
		if resp.StreamInterrupted {
			phase = "stream"
		}
		normalizedErr = &ForwardError{Message: transportErr.Error(), Phase: phase}
	}

	return ReportOutcome{
		Outcome:           outcome,
		UpstreamStatus:    resp.StatusCode,
		Error:             normalizedErr,
		StreamInterrupted: resp.StreamInterrupted,
	}
}
