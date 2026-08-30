from .cli import handle_cli, setup_cli


def register(ctx):
    ctx.register_cli_command(
        name="trajectory",
        help="Analyze persisted Hermes session trajectories",
        setup_fn=setup_cli,
        handler_fn=handle_cli,
        description="Local, privacy-safe trajectory analysis",
    )
