import argparse

from .analyzer import METHODOLOGY_WARNING, analyze, open_runtime_store, validate_days


def _positive_days(value):
    try:
        return validate_days(int(value))
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def setup_cli(subparser):
    commands = subparser.add_subparsers(dest="trajectory_command")
    analyze_parser = commands.add_parser("analyze", help="Analyze persisted session trajectories")
    analyze_parser.add_argument("--days", type=_positive_days, default=30)
    analyze_parser.add_argument("--source")


def handle_cli(args, store=None):
    if getattr(args, "trajectory_command", None) != "analyze":
        raise SystemExit("Usage: hermes trajectory analyze")
    runtime_store = store is None
    selected_store = store or open_runtime_store()
    try:
        report = analyze(selected_store, days=args.days, source=args.source)
        _print_report(report)
        return report
    finally:
        if runtime_store:
            selected_store.close()


def _print_report(report):
    print("Trajectory analysis")
    print(
        f"sessions={report['sessions_analyzed']} "
        f"turns={report['turns_analyzed']}"
    )
    for finding in report["findings"]:
        code = finding["code"]
        if code == "high_assistant_steps_per_turn":
            measurement = _finding_measurement(finding)
        elif code == "high_tool_fanout_per_turn":
            measurement = _finding_measurement(finding)
        elif code == "repeated_exact_tool_call":
            measurement = _finding_measurement(finding)
        elif code == "large_tool_payload":
            measurement = (
                f"turn_user_message_id={finding['turn_user_message_id']} "
                f"tool_message_id={finding['tool_message_id']} tool_name={finding['tool_name']} "
                f"payload_bytes={finding['observed']['payload_bytes']} "
                f"later_assistant_steps={finding['observed']['later_assistant_steps']} "
                f"impact={finding['impact']['kind']} "
                f"estimated_tokens={finding['impact']['tokens']}"
            )
        else:
            raise ValueError(f"Unsupported finding code: {code}")
        print(
            f"{code} severity={finding['severity']} "
            f"session_id={finding['session_id']} turn_index={finding['turn_index']} "
            f"{measurement}"
        )
        recommendation = _recommendation(code)
        if recommendation:
            print(f"Recommendation: {recommendation}")
    print(f"Methodology: {METHODOLOGY_WARNING}")


def _finding_measurement(finding):
    if finding["code"] == "high_assistant_steps_per_turn":
        return f"assistant_steps={finding['assistant_steps']}"
    if finding["code"] == "high_tool_fanout_per_turn":
        return f"tool_calls={finding['tool_calls']}"
    return (
        f"tool_name={finding['tool_name']} fingerprint={finding['fingerprint']} "
        f"repeat_count={finding['repeat_count']}"
    )


def _recommendation(code):
    if code == "high_tool_fanout_per_turn":
        return "Review batching, caching, or execute_code for safe aggregation."
    if code == "repeated_exact_tool_call":
        return "Review caching or execute_code, while preserving legitimate retries."
    return None
