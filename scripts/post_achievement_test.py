"""
One-off: posts the "most damage" seasonal-achievement badge prototype to
the live Discord channel, so the pod can see what the idea looks like.
The seasonal achievements feature itself is on hold -- this script (and
its workflow) exist only to share this one prototype and should be
deleted once that's done.

Reads DISCORD_WEBHOOK_URL from the environment, same as the real
Discord scripts (see discord_report.py).

Usage:
    python scripts/post_achievement_test.py
"""
import io
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Polygon

from discord_report import post_image, post_message

TEXT_DARK = "#1a1a1a"
TEXT_SECONDARY = "#5f5e5a"
TEXT_MUTED = "#888780"


def build_badge_png():
    fig, ax = plt.subplots(figsize=(6.8, 6.0), dpi=200)
    ax.set_xlim(0, 680)
    ax.set_ylim(0, 600)
    ax.invert_yaxis()
    ax.axis("off")
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    ax.add_patch(Circle((340, 150), 108, facecolor="#A32D2D", edgecolor="#791F1F", linewidth=3, zorder=2))
    bolt = [(348, 72), (305, 153), (335, 153), (322, 228), (378, 135), (343, 135)]
    ax.add_patch(Polygon(bolt, closed=True, facecolor="#FAEEDA", edgecolor="none", zorder=3))

    ax.text(340, 310, "SEASON 3 ACHIEVEMENT", ha="center", va="center", fontsize=11, color=TEXT_MUTED, family="DejaVu Sans")
    ax.text(340, 352, "I hate my friends", ha="center", va="center", fontsize=24, color=TEXT_DARK, family="DejaVu Sans", weight="bold")
    ax.text(340, 418, "Mateo", ha="center", va="center", fontsize=36, color=TEXT_DARK, family="DejaVu Sans", weight="bold")
    ax.text(340, 494, "1,131", ha="center", va="center", fontsize=44, color=TEXT_DARK, family="DejaVu Sans", weight="bold")
    ax.text(340, 530, "TOTAL DAMAGE DEALT", ha="center", va="center", fontsize=11, color=TEXT_MUTED, family="DejaVu Sans")
    ax.text(340, 566, "14 of 16 games   ·   237 best hit   ·   81 avg per game", ha="center", va="center", fontsize=12, color=TEXT_SECONDARY, family="DejaVu Sans")

    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=200, bbox_inches="tight", facecolor="white", pad_inches=0.25)
    plt.close(fig)
    buf.seek(0)
    return buf


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]
    post_message(webhook_url, "Prototyping a seasonal achievements idea -- here's a taste \U0001F447")
    post_image(webhook_url, "", build_badge_png(), "achievement_most_damage.png")
    print("Posted achievement badge prototype to Discord.")


if __name__ == "__main__":
    main()
