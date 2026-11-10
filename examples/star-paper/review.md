## Summary of contribution

The paper presents STAR, a robot skill learning framework. It has two parts. The first part is RaRSQ, a residual vector quantizer that uses the rotation trick to pass gradients to the encoder. The second part is CST, a causal transformer that predicts skill codes from coarse to fine and adds an offset head [C2] (p. 4, Section 3.2.1).

The authors claim that RaRSQ prevents codebook collapse. They also claim that the framework gives about 12% improvement over the baselines [C1] (p. 1, Abstract). They report 92.7% on MetaWorld MT50 [C3] (p. 6, Section 4.2).

The method is tested on LIBERO (five suites), MetaWorld MT50 and two real-world tasks on a single arm of an ALOHA robot. The paper compares STAR with VQ-BeT, QueST, ResNet-T, Diffusion Policy, ACT, Octo and OpenVLA.

## Strengths

- The paper measures codebook use. Naive VQ-VAE uses only 7 of 16 codes [S1] (p. 7, Section 4.3).
- The paper states the LIBERO demonstration count [S2] (p. 12, Appendix A.1.1).
- The real-world success rule is strict. A trial counts only if all stages are correct [S3] (p. 14, Appendix A.3.2).
- Table 2 ablates the parts on all five LIBERO suites with std [S5] (p. 7, Section 4.4). Removing the autoregressive prediction lowers the overall score by 4.1 points [S6] (p. 7).
- The paper adds an ablation for action refinement [S4] (p. 15, Appendix B.1).
- The appendix lists many hyperparameters and the compute used [S7] (p. 14, Appendix A.4).

## Weaknesses

1. **Most of the gain does not come from the proposed ideas (serious).** The variant without rotation and without AR scores 87.8% [W1] (p. 7, Section 4.4). This is 6.3 points above QueST (81.5%). Removing rotation alone costs 2.6 points [W2] (p. 7). Removing the offset head costs 34.6 points [W3] (p. 15, Appendix B.1). The offset head comes from BeT. The authors must show a baseline with the same offset head and the same encoders. They must then state how much of the 12.1-point gain each new part explains.
2. **The method at inference is not clear (serious).** Eq. 19 uses a rotation matrix Rd [W4] (p. 5, Section 3.2.3). Rd needs the encoder residual, and that residual does not exist at inference. Eq. 22 omits Rd. The authors must explain which form they use in the reported results.
3. **The explanation for the gain is not tested (serious).** The paper says the gap on complex tasks comes from codebook collapse [W5] (p. 6, Section 4.2). The paper never measures collapse in VQ-BeT or QueST. The rotation ablation is largest on LIBERO-Object, a simple suite. The authors must measure collapse in the baselines.
4. **Real-world evidence is weak (serious).** The paper says STAR is significantly better [W8] (p. 8, Section 4.5). The data are 6 of 10 against 3 and 4 of 10. There are 10 trials and no variance or test [W9] (p. 13, Appendix A.3.2). There are only two tasks and two baselines. The authors must add more trials and report confidence intervals.
5. **The Octo and OpenVLA comparison is not controlled.** These numbers are copied from other papers [W6] (p. 6, Table 1). The paper says they used more training data [W7] (p. 6). It gives no data count or protocol. The authors must re-run them or remove the claim.
6. **Main text and appendix conflict.** See the detailed comments [W10] [W11] [W12] [W13] [W14]. The authors must correct the text.
7. **Baselines differ from STAR.** VQ-BeT uses about 1024 codes and a window of 5 [W15] (p. 15, Appendix A.5.2). STAR uses 16 codes and 8 steps. The authors must justify the choice or give a matched setting.
8. **Some claims do not match the tables.** See the detailed comments [W16] [W17] [W18] [W24].
9. **The Theoretical Benefits section has no theory.** It lists three advantages without proof or test [W20] (p. 5, Section 3.2.2). The authors must rename the section or add a proof.
10. **The limitations are mild.** The authors list manual tuning and the need for expert data [W21] (p. 9, Limitations). They omit the small real-world trial count and the code status.
11. **Data and setup details are scattered.** MetaWorld uses scripted demonstrations [W19] (p. 13, Appendix A.1.2). The real-world setup lacks details [W22] (p. 13, Appendix A.2). The paper claims the real tasks match LIBERO-Long with no evidence [W23] (p. 8, Section 4.5).

## Detailed comments

### Statistics, trials, seeds and variance

The paper uses three seeds and 50 episodes per task [Q1] (p. 13, Appendix A.3.1). It is not clear if the seeds are separate training runs. Table 1 and Table 2 give std. Figure 3 for MetaWorld gives no std [W24] (p. 6, Section 4.2). The MetaWorld gains are 2.1 to 5.4 points. The paper cannot say if they are larger than the variance. The real-world result uses 10 trials [W9]. Question for the authors: do the seeds cover training? [Q1]

### Baseline fairness (re-run or copied)

Octo and OpenVLA are copied [W6]. The other baselines were re-run. They differ in code size, window length and decoding [W15]. STAR uses sampling, and QueST uses beam search. The paper says it uses consistent encoders. A.5.2 shows different encoders for ResNet-T and others. No tuning budget is given for the baselines.

### Data budget

LIBERO uses 50 human demonstrations per task [S2]. MetaWorld uses 100 scripted demonstrations per task [W19]. The real robot uses 45 human demonstrations per task (p. 13, Appendix A.2). The paper does not say that Octo and OpenVLA use more data in the table. It only claims this in the text [W7]. The paper does not say how much data they saw.

### Claims against tables

I recomputed the numbers. The overall mean of STAR is 93.6. The gain over QueST is 12.1 points, so the abstract claim holds [C1]. The LIBERO-Long gain is 19.4 and the LIBERO-Object gain is 8.3. The ranges 7.2%-12.6% and 18.3%-33.9% do not match the best baselines [W16] (p. 6, Section 4.2). The gain on Spatial over the best baseline is 6.8. The ablation drops in Section 4.4 and Appendix B.1 match Table 2 and Table 5. The "synergistic effect" is sub-additive [W17] (p. 7, Section 4.4). The mean usage of 6.25% is a fixed value for 16 codes and not evidence [W18] (p. 7, Section 4.3). MetaWorld numbers match the figure [C3]. Table 1 says "normalized score", and the text says success rate.

### Do the ablations explain the gain?

No. The variant without the main ideas stays above all baselines [W1]. Rotation adds 2.6 points [W2]. AR adds 4.1 points [S6]. The offset head adds 34.6 points [W3]. This part comes from BeT. The ablation of Table 2 does not test a codebook-collapse measure. The ablation on action refinement is useful [S4], but it shows where the gain comes from.

### Main text against appendix contradictions

- The visual encoder is trained from scratch [W10] (p. 14, Appendix A.4). The next sentences say the visual and language encoders are frozen [W11].
- Section 3.2.4 uses nucleus sampling [Q2] (p. 5, Section 3.2.4). The appendix names a beam size of 5 [W12] (p. 14).
- ACT is a CVAE in A.5.1 [W14] (p. 14). In A.5.2 it discretizes actions into 256 bins [W13] (p. 15).
- Eq. 19 uses Rd, and Eq. 22 does not [W4].

### Assumptions

The method needs a fixed codebook size and depth (K = 16 and D = 2). These are not tested. The method assumes that rotation gradients prevent collapse. The paper does not test this on baselines [W5]. Figure 4 shows one setting only [Q3] (p. 7, Section 4.3). The loss analysis assumes lower quantization loss helps the policy [Q4] (p. 18, Appendix C.3). The paper gives no test for this link. The theory section gives no proof [W20].

### Reproducibility and code

The hyperparameters and the compute are given [S7]. The paper lists a project page name only. It does not state that code or checkpoints are released. The decoding method and the encoder status are not clear [W11] [W12]. The authors must fix these before others can re-run.

### Limitations honesty

The limitations are mild [W21]. They omit the small real-world sample, the missing variance for MetaWorld, and the large effect of the BeT offset head.

### Simulation against real robot

The real-world tasks have two stages or three stages. The paper claims they match LIBERO-Long [W23]. The setup lacks camera, reset and object details [W22]. The paper compares only VQ-BeT and QueST. The paper claims better degradation for STAR [Q5] (p. 8, Section 4.5). STAR falls from 6 to 3 and VQ-BeT from 4 to 1. With 10 trials the difference is not reliable [W8]. The real-world results cannot support the simulation claims.

## Would you nominate this paper for the Best Paper Award? and why?

No. The idea of rotation gradients in skill quantization is reasonable. The simulation results are strong in absolute numbers [S1] [S5]. But the ablations show that the new parts explain a small share of the gain [W1] [W2] [W3]. The inference method is not clear [W4]. The real-world evidence has only 10 trials per task [W8] [W9]. The text and the appendix conflict [W11] [W12]. The authors must fix these points first.
