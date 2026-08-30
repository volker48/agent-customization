import argparse

from .analyzer import METHODOLOGY_WARNING, analyze, open_runtime_store


def _positive_days(value):
    days = int(value)
    if days < 1:
        raise argparse.ArgumentTypeError("--days must be at least 1")
    return days


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
        print(
            f"{finding['code']} severity={finding['severity']} "
            f"session_id={finding['session_id']} turn_index={finding['turn_index']} "
            f"assistant_steps={finding['assistant_steps']}"
        )
    print(f"Methodology: {METHODOLOGY_WARNING}")
