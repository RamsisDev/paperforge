# Introduction {#sec:intro}

Write your paper in **Markdown** and PaperForge typesets it with the template you pick.
Cite with `[@key]` [@knuth1984; @lamport1994] or in the text: @shannon1948 showed that
information can be measured. Refer to @sec:method, @fig:example, @tbl:results and @eq:entropy.

# Method {#sec:method}

Inline math works as usual, $H(X) \ge 0$, and labeled display equations are numbered:

$$H(X) = -\sum_{i=1}^{n} p(x_i) \log_2 p(x_i)$$ {#eq:entropy}

![A sample figure. Add `{.wide}` to span both columns.](figures/example.png){#fig:example width=90%}

## Results

| Model    | Accuracy | Latency (ms) |
|:---------|---------:|-------------:|
| Baseline |    0.812 |           14 |
| Ours     |**0.874** |           11 |

: Results on the test set. {#tbl:results}

Raw LaTeX passes through untouched when you need it: \LaTeX{} rules.

# Conclusion

Lists, *emphasis*, footnotes[^1] and `code` are all supported.

- First point
- Second point

[^1]: Footnotes go to the bottom of the page.
