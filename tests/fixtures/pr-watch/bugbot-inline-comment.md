### gh no-PR errors misclassified

**High Severity**

<!-- DESCRIPTION START -->
When `gh pr view` finds no PR, it often reports `no open pull requests found for branch …`, which does not match the script’s `no pull requests found` / `no pull request found` grep. The script then exits with “Unable to check existing PR” or “Unable to check PR state” instead of continuing to push or create a PR.
<!-- DESCRIPTION END -->

<!-- BUGBOT_BUG_ID: a1457670-d74d-4964-83de-d0319941c5aa -->

<!-- LOCATIONS START
.claude/skills/pr-push/scripts/pr_push.sh#L247-L250
.claude/skills/pr-push/scripts/pr_push.sh#L328-L331
LOCATIONS END -->
<details>
<summary>Additional Locations (1)</summary>

- [`.claude/skills/pr-push/scripts/pr_push.sh#L328-L331`](https://github.com/dyad-sh/dyad/blob/0cd88eac1fca509c1680ab7b366c5a59b2b083ce/.claude/skills/pr-push/scripts/pr_push.sh#L328-L331)

</details>

<div><a href="https://cursor.com/open?link=eyJ2ZXJzaW9uIjoxLCJ0eXBlIjoiQlVHQk9UX0ZJWF9JTl9DVVJTT1IiLCJkYXRhIjp7InJlZGlzS2V5IjoiYnVnYm90OmIzYjI4ZGQ3LWI4ZDgtNDIwYS05MzJlLTQyZWE4ODQ1NDkwZCIsImVuY3J5cHRpb25LZXkiOiJOekYyZDlBdm5fb3FlczNseGtrS05jRjE4R3dmbmZmOGRobWRXb19yd3BjIiwiYnJhbmNoIjoiZmFzdC1wci1wdXNoLXNraWxsIiwicmVwb093bmVyIjoiZHlhZC1zaCIsInJlcG9OYW1lIjoiZHlhZCJ9fQ" target="_blank" rel="noopener noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/fix-in-cursor-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/fix-in-cursor-light.png"><img alt="Fix in Cursor" width="115" height="28" src="https://cursor.com/assets/images/fix-in-cursor-dark.png"></picture></a>&nbsp;<a href="https://cursor.com/agents?link=eyJ2ZXJzaW9uIjoxLCJ0eXBlIjoiQlVHQk9UX0ZJWF9JTl9XRUIiLCJkYXRhIjp7InJlZGlzS2V5IjoiYnVnYm90OmIzYjI4ZGQ3LWI4ZDgtNDIwYS05MzJlLTQyZWE4ODQ1NDkwZCIsImVuY3J5cHRpb25LZXkiOiJOekYyZDlBdm5fb3FlczNseGtrS05jRjE4R3dmbmZmOGRobWRXb19yd3BjIiwiYnJhbmNoIjoiZmFzdC1wci1wdXNoLXNraWxsIiwicmVwb093bmVyIjoiZHlhZC1zaCIsInJlcG9OYW1lIjoiZHlhZCIsInByTnVtYmVyIjozODA0LCJjb21taXRTaGEiOiIwY2Q4OGVhYzFmY2E1MDljMTY4MGFiN2IzNjZjNWE1OWIyYjA4M2NlIiwicHJvdmlkZXIiOiJnaXRodWIifX0" target="_blank" rel="noopener noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/fix-in-web-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/fix-in-web-light.png"><img alt="Fix in Web" width="99" height="28" src="https://cursor.com/assets/images/fix-in-web-dark.png"></picture></a></div>


<sup>Reviewed by [Cursor Bugbot](https://cursor.com/bugbot) for commit 0cd88eac1fca509c1680ab7b366c5a59b2b083ce. Configure [here](https://www.cursor.com/dashboard/bugbot).</sup>

