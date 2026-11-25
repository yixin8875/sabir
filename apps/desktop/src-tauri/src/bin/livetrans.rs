fn main() {
    app_lib::cli::run(std::env::args().skip(1).collect());
}
