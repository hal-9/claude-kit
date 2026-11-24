window.SCENES = [
  {
    "id": "hook",
    "start": 0,
    "duration": 9.09,
    "captions": [
      {
        "text": "Agents can write a whole feature while you get coffee.",
        "start": 0,
        "end": 3.12
      },
      {
        "text": "The hard part is knowing whether to trust it.",
        "start": 3.12,
        "end": 5.72
      },
      {
        "text": "And still understanding your own code afterwards.",
        "start": 5.72,
        "end": 8.54
      }
    ]
  },
  {
    "id": "command",
    "start": 9.09,
    "duration": 9.93,
    "captions": [
      {
        "text": "Story loop takes one Shortcut story, or a GitHub issue, and one command, and carries it all the way to a reviewed pull request, ready for you to merge.",
        "start": 9.09,
        "end": 18.47
      }
    ]
  },
  {
    "id": "contract",
    "start": 19.02,
    "duration": 12.16,
    "captions": [
      {
        "text": "It starts with a contract.",
        "start": 19.02,
        "end": 20.7
      },
      {
        "text": "The agent drafts the plan and the test steps, asks about the gaps, and proposes a lane, how careful this change has to be.",
        "start": 20.7,
        "end": 28.57
      },
      {
        "text": "Nothing is built until you sign.",
        "start": 28.57,
        "end": 30.63
      }
    ]
  },
  {
    "id": "build",
    "start": 31.18,
    "duration": 8.21,
    "captions": [
      {
        "text": "Then it builds.",
        "start": 31.18,
        "end": 32.13
      },
      {
        "text": "The plan is split into tasks, and worker agents of different strengths write the code, one test at a time.",
        "start": 32.13,
        "end": 38.84
      }
    ]
  },
  {
    "id": "prove",
    "start": 39.39,
    "duration": 17.83,
    "captions": [
      {
        "text": "Now the work has to prove itself.",
        "start": 39.39,
        "end": 41.53
      },
      {
        "text": "A quality gate runs the linters, and looks for shortcuts.",
        "start": 41.53,
        "end": 45.24
      },
      {
        "text": "Every changed line is broken on purpose, to see if a test notices.",
        "start": 45.24,
        "end": 49.52
      },
      {
        "text": "Then a second agent, that never saw the code, checks each test step in a real browser, and keeps a screenshot.",
        "start": 49.52,
        "end": 56.67
      }
    ]
  },
  {
    "id": "reviews",
    "start": 57.22,
    "duration": 17.31,
    "captions": [
      {
        "text": "Then a second model, ideally from another company, tries to tear it apart, and holds it to your repo's own standards.",
        "start": 57.22,
        "end": 64.97
      },
      {
        "text": "After the push, GitHub Copilot reviews it again.",
        "start": 64.97,
        "end": 68.15
      },
      {
        "text": "Clear defects are fixed, and go back through the loop.",
        "start": 68.15,
        "end": 71.73
      },
      {
        "text": "Open questions are parked for you.",
        "start": 71.73,
        "end": 73.98
      }
    ]
  },
  {
    "id": "learn",
    "start": 74.53,
    "duration": 11.23,
    "captions": [
      {
        "text": "Then it waits for your review.",
        "start": 74.53,
        "end": 76.28
      },
      {
        "text": "Your comments are settled like any other finding.",
        "start": 76.28,
        "end": 79.14
      },
      {
        "text": "And once you merge, a retro turns every correction into a lesson, and a check that catches it next time.",
        "start": 79.14,
        "end": 85.21
      }
    ]
  },
  {
    "id": "board",
    "start": 85.76,
    "duration": 6.73,
    "captions": [
      {
        "text": "You follow all of it on a live board.",
        "start": 85.76,
        "end": 88.27
      },
      {
        "text": "The stages.",
        "start": 88.27,
        "end": 89.02
      },
      {
        "text": "Who is working on what.",
        "start": 89.02,
        "end": 90.58
      },
      {
        "text": "And what was tested.",
        "start": 90.58,
        "end": 91.94
      }
    ]
  },
  {
    "id": "understand",
    "start": 92.49,
    "duration": 12.62,
    "captions": [
      {
        "text": "And you stay in touch with the code.",
        "start": 92.49,
        "end": 95
      },
      {
        "text": "For every changed file, you can ask:",
        "start": 95,
        "end": 97.52
      },
      {
        "text": "explain this.",
        "start": 97.52,
        "end": 98.42
      },
      {
        "text": "Why here?",
        "start": 98.42,
        "end": 99.05
      },
      {
        "text": "How does it connect?",
        "start": 99.05,
        "end": 100.45
      },
      {
        "text": "If you disagree, tell the agent, and it picks up your note.",
        "start": 100.45,
        "end": 104.56
      }
    ]
  },
  {
    "id": "limits",
    "start": 105.11,
    "duration": 8.91,
    "captions": [
      {
        "text": "Some things it will never do.",
        "start": 105.11,
        "end": 107.18
      },
      {
        "text": "It pushes only to the story branch.",
        "start": 107.18,
        "end": 109.68
      },
      {
        "text": "It never merges.",
        "start": 109.68,
        "end": 110.83
      },
      {
        "text": "A human approves, and a human merges.",
        "start": 110.83,
        "end": 113.47
      }
    ]
  },
  {
    "id": "start",
    "start": 114.02,
    "duration": 8.91,
    "captions": [
      {
        "text": "To begin, run story loop setup.",
        "start": 114.02,
        "end": 115.91
      },
      {
        "text": "It checks your machine, and walks you through anything that is missing.",
        "start": 115.91,
        "end": 120.24
      },
      {
        "text": "Then pick a small story, and watch.",
        "start": 120.24,
        "end": 122.38
      }
    ]
  }
]
