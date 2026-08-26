# OpenAgentCouncil

OpenAgentCouncil models a deliberative council that helps one user make better decisions by combining independent specialist perspectives.

## Language

**Council**:
A reusable group consisting of one Chair and at least two other Council Members, so a Deliberation can reach Quorum without the neutral Chair taking a Position.
_Avoid_: Chat, group, agent team

**Chair**:
The Council Member responsible for directing a Deliberation, selecting participants, requesting necessary clarification from the user and synthesizing the outcome. Other Council Members cannot pause a Deliberation to question the user directly.
_Avoid_: Moderator, orchestrator, manager

**Council Member**:
An agent with a declared specialist role and perspective within a Council.
_Avoid_: Bot, assistant, worker

**Member Handle**:
A Council Member's unique, mentionable identifier within a Council.
_Avoid_: Display name, role, username

**Member Profile**:
A reusable Markdown description of a Council Member's role, perspective and standing instructions.
_Avoid_: Persona, base prompt, system prompt

**Engineering Council**:
The default Council composed of a Chair, Researcher, Critic and Prototyper.
_Avoid_: Default Council, developer team

**Session**:
The persistent record of interactions between one user and one Council.
_Avoid_: Chat, thread, conversation

**Deliberation**:
A bounded discussion and investigation of one concrete question within a Session.
_Avoid_: Task, chat

**Round**:
A coordinated phase of a Deliberation involving the Council Members selected by the Chair.
_Avoid_: Turn, cycle

**Position**:
A Council Member's independent initial view, formed before it sees other members' contributions.
_Avoid_: Answer, opinion, response

**Assignment**:
A user-approved request that allows one Council Member to modify the workspace in support of a Deliberation.
_Avoid_: Task, job

**Recommendation**:
The Chair's closing synthesis of a Deliberation, including its reasoning and remaining uncertainty after review by the participating Council Members.
_Avoid_: Answer, verdict, summary

**Draft Recommendation**:
A Chair synthesis that is awaiting a Review Round and is not yet a Recommendation.
_Avoid_: Recommendation, provisional answer

**Dissent**:
A materially different conclusion from a Council Member that remains visible alongside the Recommendation.
_Avoid_: Disagreement, minority opinion

**Review Round**:
A final, bounded Round in which participating Council Members check a draft Recommendation for errors, omissions and unresolved Dissent.
_Avoid_: Approval, vote, sign-off

**Quorum**:
The minimum of two completed Positions from different Council Members required for a normal Recommendation.
_Avoid_: Consensus, majority

**Incomplete Deliberation**:
A Deliberation that ends without Quorum or a completed review and therefore produces no Recommendation.
_Avoid_: Failed Recommendation, partial Recommendation

**Artifact**:
A file or other tangible output created through an Assignment to provide runnable evidence for a Deliberation.
_Avoid_: Deliverable, attachment
